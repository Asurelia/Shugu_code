//! Contract test shared by every provider allowed to run as a Shugu agent.
//!
//! The server is a real loopback HTTP endpoint. It scripts the same six-turn
//! plan → write → red check → edit → green check → final cycle in each native
//! wire dialect, while the client rebuilds and sends the complete tool history
//! at every turn. This catches adapters that can parse one tool call but cannot
//! actually sustain an agent loop.

use super::{build_anthropic_native, build_ollama_messages, build_openai_messages, AgentMessage};
use crate::commands::agents::lifecycle::{CompletionDecision, RunEvidence};
use crate::commands::agents::{ToolCall, ToolResult};
use crate::commands::chat::{
    call_anthropic_structured, call_ollama_structured, call_openai_compat_structured, AssistantTurn,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const TOOL_ROUNDS: usize = 5;
static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

fn scripted_call(round: usize) -> Option<(&'static str, Value)> {
    match round {
        0 => Some((
            "todo_write",
            json!({
                "todos": [
                    {"id":"implement","text":"write the expected value","status":"in_progress"},
                    {"id":"verify","text":"run the real check","status":"pending","depends_on":["implement"]}
                ]
            }),
        )),
        1 => Some((
            "fs_write_file",
            json!({"path":"answer.txt","content":"red"}),
        )),
        2 => Some(("run_command", json!({"command":"verify answer.txt"}))),
        3 => Some((
            "fs_edit",
            json!({
                "path":"answer.txt",
                "old_string":"red",
                "new_string":"green"
            }),
        )),
        4 => Some(("run_command", json!({"command":"verify answer.txt"}))),
        _ => None,
    }
}

fn openai_payload(round: usize) -> String {
    let event = if let Some((name, args)) = scripted_call(round) {
        json!({
            "choices": [{
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "id": format!("call-{round}"),
                        "function": {"name": name, "arguments": args.to_string()}
                    }]
                }
            }]
        })
    } else {
        json!({"choices":[{"delta":{"content":"verified green"}}]})
    };
    format!("data: {event}\n\ndata: [DONE]\n\n")
}

fn anthropic_payload(round: usize) -> String {
    if let Some((name, args)) = scripted_call(round) {
        let start = json!({
            "type":"content_block_start",
            "index":0,
            "content_block":{"type":"tool_use","id":format!("call-{round}"),"name":name}
        });
        let delta = json!({
            "type":"content_block_delta",
            "index":0,
            "delta":{"type":"input_json_delta","partial_json":args.to_string()}
        });
        format!("data: {start}\n\ndata: {delta}\n\n")
    } else {
        let delta = json!({
            "type":"content_block_delta",
            "index":0,
            "delta":{"type":"text_delta","text":"verified green"}
        });
        format!("data: {delta}\n\n")
    }
}

fn ollama_payload(round: usize) -> String {
    if let Some((name, args)) = scripted_call(round) {
        format!(
            "{}\n{}\n",
            json!({
                "message": {
                    "role":"assistant",
                    "content":"",
                    "tool_calls":[{"function":{"name":name,"arguments":args}}]
                },
                "done":false
            }),
            json!({"message":{"role":"assistant","content":""},"done":true})
        )
    } else {
        format!(
            "{}\n",
            json!({"message":{"role":"assistant","content":"verified green"},"done":true})
        )
    }
}

async fn read_json_request(socket: &mut tokio::net::TcpStream) -> Value {
    let mut request = Vec::new();
    let mut buffer = [0u8; 4096];
    let header_end = loop {
        let read = socket.read(&mut buffer).await.expect("read request");
        assert!(read > 0, "connection closed before HTTP headers");
        request.extend_from_slice(&buffer[..read]);
        if let Some(pos) = request.windows(4).position(|window| window == b"\r\n\r\n") {
            break pos + 4;
        }
    };
    let headers = String::from_utf8_lossy(&request[..header_end]);
    let content_length: usize = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse().ok())
                .flatten()
        })
        .expect("content-length");
    while request.len() < header_end + content_length {
        let read = socket.read(&mut buffer).await.expect("read request body");
        assert!(read > 0, "connection closed before HTTP body");
        request.extend_from_slice(&buffer[..read]);
    }
    serde_json::from_slice(&request[header_end..header_end + content_length])
        .expect("provider request JSON")
}

async fn start_scripted_provider(
    protocol: &'static str,
) -> (
    String,
    tokio::sync::mpsc::UnboundedReceiver<Value>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind fake provider");
    let addr = listener.local_addr().expect("fake provider address");
    let (body_tx, body_rx) = tokio::sync::mpsc::unbounded_channel();
    let server = tokio::spawn(async move {
        for round in 0..=TOOL_ROUNDS {
            let (mut socket, _) = listener.accept().await.expect("accept provider request");
            let body = read_json_request(&mut socket).await;
            body_tx.send(body).expect("capture provider body");
            let payload = match protocol {
                "anthropic" => anthropic_payload(round),
                "ollama" => ollama_payload(round),
                _ => openai_payload(round),
            };
            let content_type = if protocol == "ollama" {
                "application/x-ndjson"
            } else {
                "text/event-stream"
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
                payload.len()
            );
            socket
                .write_all(response.as_bytes())
                .await
                .expect("write provider response");
        }
    });
    (format!("http://{addr}"), body_rx, server)
}

fn temp_workspace(protocol: &str) -> PathBuf {
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "shugu-provider-contract-{}-{protocol}-{seq}",
        std::process::id()
    ))
}

fn execute_contract_tool(root: &Path, call: &ToolCall) -> ToolResult {
    let args: Value = serde_json::from_str(&call.arguments).expect("tool arguments");
    let content = match call.name.as_str() {
        "todo_write" => "plan recorded".to_string(),
        "fs_write_file" => {
            let path = root.join(args["path"].as_str().expect("write path"));
            std::fs::write(&path, args["content"].as_str().expect("write content"))
                .expect("write contract fixture");
            format!("wrote {}", path.display())
        }
        "fs_edit" => {
            let path = root.join(args["path"].as_str().expect("edit path"));
            let before = std::fs::read_to_string(&path).expect("read contract fixture");
            let after = before.replacen(
                args["old_string"].as_str().expect("old string"),
                args["new_string"].as_str().expect("new string"),
                1,
            );
            std::fs::write(&path, after).expect("edit contract fixture");
            "edited answer.txt".to_string()
        }
        "run_command" => {
            let observed = std::fs::read_to_string(root.join("answer.txt"))
                .expect("read value for verification");
            if observed == "green" {
                "[exit 0]\n--- stdout ---\nanswer is green".to_string()
            } else {
                format!("[exit 1]\n--- stderr ---\nexpected green, got {observed}")
            }
        }
        other => panic!("unexpected scripted tool {other}"),
    };
    ToolResult {
        id: call.id.clone(),
        name: call.name.clone(),
        is_error: false,
        content,
    }
}

async fn call_provider(
    protocol: &str,
    client: &reqwest::Client,
    base_url: &str,
    history: &[AgentMessage],
) -> AssistantTurn {
    let tools = Some(json!([{
        "type":"function",
        "function":{
            "name":"todo_write",
            "description":"contract manifest",
            "parameters":{"type":"object"}
        }
    }]));
    let mut chunks = Vec::new();
    match protocol {
        "anthropic" => {
            let (messages, system) = build_anthropic_native(history);
            call_anthropic_structured(
                client,
                base_url,
                "fake-claude",
                messages,
                system,
                "test-key",
                true,
                tools,
                None,
                &mut |kind, chunk| chunks.push((kind.to_string(), chunk.to_string())),
            )
            .await
        }
        "ollama" => {
            call_ollama_structured(
                client,
                base_url,
                "fake-qwen",
                build_ollama_messages(history),
                tools,
                None,
                &mut |kind, chunk| chunks.push((kind.to_string(), chunk.to_string())),
            )
            .await
        }
        _ => {
            call_openai_compat_structured(
                client,
                base_url,
                "fake-gpt",
                build_openai_messages(history),
                "test-key",
                protocol,
                &None,
                true,
                tools,
                None,
                None,
                &mut |kind, chunk| chunks.push((kind.to_string(), chunk.to_string())),
            )
            .await
        }
    }
    .unwrap_or_else(|error| panic!("{protocol} provider contract failed: {error}"))
}

fn body_contains(body: &Value, needle: &str) -> bool {
    body.to_string().contains(needle)
}

async fn run_contract(protocol: &'static str) {
    let root = temp_workspace(protocol);
    std::fs::create_dir_all(&root).expect("create contract workspace");
    let (base_url, mut bodies_rx, server) = start_scripted_provider(protocol).await;
    let client = reqwest::Client::new();
    let mut history = vec![
        AgentMessage::Text {
            role: "system".into(),
            content: "Execute tools and verify the result.".into(),
        },
        AgentMessage::Text {
            role: "user".into(),
            content: "Make answer.txt contain green.".into(),
        },
    ];
    let mut evidence = RunEvidence::default();
    let mut bodies = Vec::new();
    let mut ids = Vec::new();

    for expected_round in 0..TOOL_ROUNDS {
        let turn = call_provider(protocol, &client, &base_url, &history).await;
        let body = bodies_rx.recv().await.expect("captured provider request");
        bodies.push(body);
        assert_eq!(
            turn.tool_calls.len(),
            1,
            "{protocol} round {expected_round}"
        );
        let call = turn.tool_calls[0].clone();
        let (expected_name, _) = scripted_call(expected_round).expect("scripted tool");
        assert_eq!(
            call.name, expected_name,
            "{protocol} round {expected_round}"
        );
        ids.push(call.id.clone());

        let result = execute_contract_tool(&root, &call);
        evidence.observe_round(std::slice::from_ref(&call), std::slice::from_ref(&result));
        history.push(AgentMessage::AssistantWithTools {
            content: turn.content,
            tool_calls: vec![call],
        });
        history.push(AgentMessage::ToolResults(vec![result]));
    }

    let final_turn = call_provider(protocol, &client, &base_url, &history).await;
    bodies.push(
        bodies_rx
            .recv()
            .await
            .expect("captured final provider request"),
    );
    server.await.expect("scripted provider task");

    assert!(
        final_turn.tool_calls.is_empty(),
        "{protocol} must terminate in text"
    );
    assert_eq!(final_turn.content, "verified green");
    assert_eq!(
        std::fs::read_to_string(root.join("answer.txt")).unwrap(),
        "green"
    );
    assert_eq!(
        evidence.completion_decision(false),
        CompletionDecision::Complete
    );
    assert_eq!(
        ids.len(),
        ids.iter().collect::<std::collections::HashSet<_>>().len()
    );

    assert!(bodies[0]["tools"]
        .as_array()
        .is_some_and(|items| !items.is_empty()));
    let final_body = bodies.last().expect("final request body");
    assert!(body_contains(final_body, "expected green, got red"));
    assert!(body_contains(final_body, "answer is green"));
    match protocol {
        "anthropic" => {
            assert!(body_contains(final_body, "tool_use"));
            assert!(body_contains(final_body, "tool_result"));
        }
        "ollama" => {
            assert!(body_contains(final_body, "tool_calls"));
            assert!(body_contains(final_body, "tool_name"));
        }
        _ => {
            assert!(body_contains(final_body, "tool_call_id"));
            assert!(body_contains(final_body, "\"role\":\"tool\""));
        }
    }

    std::fs::remove_dir_all(&root).expect("remove contract workspace");
}

#[tokio::test]
async fn native_provider_dialects_sustain_a_verified_agent_cycle() {
    for protocol in ["anthropic", "openai", "custom", "ollama"] {
        run_contract(protocol).await;
    }
}
