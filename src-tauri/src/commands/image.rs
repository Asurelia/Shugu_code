use serde::{Deserialize, Serialize};

/// Arguments received from the JS `invoke("image_generate", {...})` call.
/// JS uses camelCase, so we rename all fields accordingly.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenerateArgs {
    pub prompt: String,
    #[serde(default)]
    pub negative: Option<String>,
    pub ratio: String,
    pub model: String,
    /// "comfyui" | "replicate" | "stability" | "openai" | "custom"
    pub protocol: String,
    /// Base URL for the provider, e.g. "https://api.replicate.com"
    ///
    /// SECURITY NOTE: For the `custom` protocol this value is user-supplied and
    /// is used directly in an outbound HTTP request — a known SSRF surface.
    /// This is acceptable for a desktop app where the user configures their own
    /// providers, but a future improvement should validate against an allowlist
    /// of user-approved origins before sending.
    pub base_url: String,
    /// Optional API key. If `Some` and non-empty it takes precedence over the
    /// corresponding environment variable.
    pub api_key: Option<String>,
    /// Optional sampling parameters forwarded to the backend where supported.
    pub seed: Option<u32>,
    pub steps: Option<u32>,
    pub guidance: Option<f32>,
    /// Style hint (e.g. "painterly") — forwarded where supported.
    pub style: Option<String>,
}

/// Returned to JS for every protocol. JS sees camelCase via `rename_all`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageJob {
    pub id: String,
    pub status: String,
    pub result_url: Option<String>,
}

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

/// Returns the API key to use for the given protocol.
///
/// Priority: explicit `api_key` arg → env var → `Ok("")` for comfyui/keyless.
/// Unlike the chat resolver this never returns `Err` — a missing key causes
/// the downstream network call to fail, which is caught and turned into a
/// graceful stub response.
fn resolve_image_key(protocol: &str, api_key: &Option<String>) -> String {
    if let Some(k) = api_key {
        if !k.is_empty() {
            return k.clone();
        }
    }
    match protocol {
        "comfyui" => String::new(),
        "replicate" => std::env::var("REPLICATE_API_TOKEN").unwrap_or_default(),
        "openai" | "custom" => std::env::var("OPENAI_API_KEY").unwrap_or_default(),
        "stability" => std::env::var("STABILITY_API_KEY").unwrap_or_default(),
        _ => std::env::var("SHUGU_CUSTOM_IMAGE_KEY").unwrap_or_default(),
    }
}

// ---------------------------------------------------------------------------
// Ratio → size mapping (for OpenAI DALL-E / compatible endpoints)
// ---------------------------------------------------------------------------

fn ratio_to_size(ratio: &str) -> &'static str {
    match ratio {
        "16:9"  => "1792x1024",
        "9:16"  => "1024x1792",
        "4:3"   => "1024x1024",
        "3:4"   => "1024x1024",
        _       => "1024x1024", // default for 1:1 and unknowns
    }
}

// ---------------------------------------------------------------------------
// Fallback job constructor
// ---------------------------------------------------------------------------

fn stub_job(id: &str, protocol: &str) -> ImageJob {
    ImageJob {
        id: id.to_string(),
        status: format!("{} unreachable — stub", protocol),
        result_url: None,
    }
}

fn fallback_id() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("img-{}", ms)
}

// ---------------------------------------------------------------------------
// Per-protocol helpers
// ---------------------------------------------------------------------------

async fn call_comfyui(
    client: &reqwest::Client,
    base_url: &str,
    args: &ImageGenerateArgs,
    fallback: &str,
) -> ImageJob {
    let seed    = args.seed.unwrap_or(42);
    let steps   = args.steps.unwrap_or(20);
    let cfg     = args.guidance.unwrap_or(7.0);

    let graph = serde_json::json!({
        "prompt": {
            "3": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": seed,
                    "steps": steps,
                    "cfg": cfg,
                    "sampler_name": "euler",
                    "scheduler": "normal",
                    "denoise": 1.0,
                    "model": ["4", 0],
                    "positive": ["6", 0],
                    "negative": ["7", 0],
                    "latent_image": ["5", 0]
                }
            },
            "4": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "v1-5-pruned-emaonly.safetensors" } },
            "5": { "class_type": "EmptyLatentImage", "inputs": { "width": 512, "height": 512, "batch_size": 1 } },
            "6": { "class_type": "CLIPTextEncode", "inputs": { "text": args.prompt, "clip": ["4", 1] } },
            "7": { "class_type": "CLIPTextEncode", "inputs": { "text": args.negative.as_deref().unwrap_or(""), "clip": ["4", 1] } }
        }
    });

    let url = format!("{}/prompt", base_url.trim_end_matches('/'));
    match client.post(&url).json(&graph).send().await {
        Err(_) => stub_job(fallback, "comfyui"),
        Ok(resp) => {
            if !resp.status().is_success() {
                return stub_job(fallback, "comfyui");
            }
            let v: serde_json::Value = match resp.json().await {
                Ok(val) => val,
                Err(_)  => return stub_job(fallback, "comfyui"),
            };
            let prompt_id = v["prompt_id"].as_str().unwrap_or(fallback).to_string();
            ImageJob { id: prompt_id, status: "queued".into(), result_url: None }
        }
    }
}

async fn call_replicate(
    client: &reqwest::Client,
    base_url: &str,
    model: &str,
    args: &ImageGenerateArgs,
    api_key: &str,
    fallback: &str,
) -> ImageJob {
    // Minimal body — full model-version wiring is a documented follow-up.
    let body = serde_json::json!({
        "version": model,
        "input": {
            "prompt": args.prompt,
            "negative_prompt": args.negative.as_deref().unwrap_or(""),
            "num_inference_steps": args.steps.unwrap_or(20),
            "guidance_scale": args.guidance.unwrap_or(7.5),
            "seed": args.seed.unwrap_or(42)
        }
    });

    let url = format!("{}/v1/predictions", base_url.trim_end_matches('/'));
    let resp = match client
        .post(&url)
        .header("Authorization", format!("Token {}", api_key))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
    {
        Ok(r)  => r,
        Err(_) => return stub_job(fallback, "replicate"),
    };

    if !resp.status().is_success() {
        return stub_job(fallback, "replicate");
    }

    let v: serde_json::Value = match resp.json().await {
        Ok(val) => val,
        Err(_)  => return stub_job(fallback, "replicate"),
    };
    let id     = v["id"].as_str().unwrap_or(fallback).to_string();
    let status = v["status"].as_str().unwrap_or("starting").to_string();
    ImageJob { id, status, result_url: None }
}

async fn call_openai_images(
    client: &reqwest::Client,
    base_url: &str,
    model: &str,
    args: &ImageGenerateArgs,
    api_key: &str,
    protocol: &str,
    fallback: &str,
) -> ImageJob {
    let size = ratio_to_size(&args.ratio);
    let body = serde_json::json!({
        "model": model,
        "prompt": args.prompt,
        "n": 1,
        "size": size
    });

    let base = base_url.trim_end_matches('/');
    let url = if base.ends_with("/v1") {
        format!("{}/images/generations", base)
    } else {
        format!("{}/v1/images/generations", base)
    };

    let resp = match client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
    {
        Ok(r)  => r,
        Err(_) => return stub_job(fallback, protocol),
    };

    if !resp.status().is_success() {
        return stub_job(fallback, protocol);
    }

    let v: serde_json::Value = match resp.json().await {
        Ok(val) => val,
        Err(_)  => return stub_job(fallback, protocol),
    };
    let result_url = v["data"][0]["url"].as_str().map(String::from);
    ImageJob {
        id: fallback.to_string(),
        status: "done".into(),
        result_url,
    }
}

async fn call_stability(
    client: &reqwest::Client,
    base_url: &str,
    args: &ImageGenerateArgs,
    api_key: &str,
    fallback: &str,
) -> ImageJob {
    // Stability AI SDXL endpoint — minimal payload; full cfg wiring is a follow-up.
    let body = serde_json::json!({
        "text_prompts": [{ "text": args.prompt, "weight": 1.0 }],
        "cfg_scale": args.guidance.unwrap_or(7.0),
        "steps": args.steps.unwrap_or(30),
        "seed": args.seed.unwrap_or(0)
    });

    let url = format!(
        "{}/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image",
        base_url.trim_end_matches('/')
    );
    let resp = match client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("content-type", "application/json")
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
    {
        Ok(r)  => r,
        Err(_) => return stub_job(fallback, "stability"),
    };

    if !resp.status().is_success() {
        return stub_job(fallback, "stability");
    }

    let v: serde_json::Value = match resp.json().await {
        Ok(val) => val,
        Err(_)  => return stub_job(fallback, "stability"),
    };
    // Stability returns base64 images in artifacts[0].base64; URL display is a follow-up.
    let _ = &v["artifacts"];
    ImageJob { id: fallback.to_string(), status: "done".into(), result_url: None }
}

// ---------------------------------------------------------------------------
// Public command
// ---------------------------------------------------------------------------

/// Provider-agnostic image generation dispatcher.
///
/// Dispatches to ComfyUI, Replicate, Stability AI, OpenAI DALL-E, or an
/// OpenAI-compatible backend based on the `protocol` field.
///
/// This command NEVER returns `Err` — remote failures and missing keys always
/// degrade gracefully to a stub `ImageJob` so `pnpm dev` works without credentials.
///
/// Env vars per protocol:
///   - comfyui   — `COMFYUI_URL` (base URL, not a key)
///   - replicate — `REPLICATE_API_TOKEN`
///   - openai    — `OPENAI_API_KEY`
///   - stability — `STABILITY_API_KEY`
///   - custom    — `SHUGU_CUSTOM_IMAGE_KEY`
///
/// Follow-up TODOs:
/// - Replicate: wire real model-version IDs and poll `/predictions/{id}` for completion.
/// - ComfyUI: poll `{COMFYUI_URL}/history/{prompt_id}` to retrieve output image URL.
/// - Stability: decode base64 artifacts and surface a data-URI or saved file path.
/// - Result image display: plumb `resultUrl` through to the ImageView canvas.
#[tauri::command]
pub async fn image_generate(args: ImageGenerateArgs) -> Result<ImageJob, String> {
    // Reserved fields accepted for forward-compatibility; silence unused warnings.
    let _ = &args.style;

    let fid = fallback_id();
    let client = reqwest::Client::new();
    let protocol = args.protocol.as_str();
    let api_key = resolve_image_key(protocol, &args.api_key);

    let job = match protocol {
        "comfyui" => {
            let base = if args.base_url.is_empty() {
                std::env::var("COMFYUI_URL")
                    .unwrap_or_else(|_| "http://127.0.0.1:8188".to_string())
            } else {
                args.base_url.clone()
            };
            call_comfyui(&client, &base, &args, &fid).await
        }
        "replicate" => {
            if api_key.is_empty() {
                stub_job(&fid, "replicate")
            } else {
                call_replicate(&client, &args.base_url, &args.model, &args, &api_key, &fid).await
            }
        }
        "openai" | "custom" => {
            if api_key.is_empty() {
                stub_job(&fid, protocol)
            } else {
                call_openai_images(&client, &args.base_url, &args.model, &args, &api_key, protocol, &fid).await
            }
        }
        "stability" => {
            if api_key.is_empty() {
                stub_job(&fid, "stability")
            } else {
                call_stability(&client, &args.base_url, &args, &api_key, &fid).await
            }
        }
        other => stub_job(&fid, other),
    };

    Ok(job)
}
