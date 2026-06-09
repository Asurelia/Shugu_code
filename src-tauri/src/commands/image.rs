use base64::{engine::general_purpose, Engine as _};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, path::PathBuf, time::Duration};
use tauri::{AppHandle, Manager};

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
    /// "comfyui" | "replicate" | "stability" | "openai" | "minimax" | "custom"
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
// Local asset persistence
// ---------------------------------------------------------------------------

fn image_asset_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("image-assets");
    fs::create_dir_all(&dir).map_err(|e| format!("create image asset dir: {e}"))?;
    Ok(dir)
}

fn safe_asset_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn save_image_bytes(app: &AppHandle, id: &str, ext: &str, bytes: &[u8]) -> Result<String, String> {
    let dir = image_asset_dir(app)?;
    let stem = safe_asset_id(id);
    let ext = ext.trim_start_matches('.').to_ascii_lowercase();
    let path = dir.join(format!(
        "{}.{}",
        if stem.is_empty() { "image" } else { &stem },
        ext
    ));
    fs::write(&path, bytes).map_err(|e| format!("write image asset: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

fn decode_base64_image(raw: &str) -> Result<Vec<u8>, String> {
    let payload = raw
        .split_once(',')
        .map(|(_, rest)| rest)
        .unwrap_or(raw)
        .trim();
    general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| format!("decode base64 image: {e}"))
}

fn ext_from_content_type(content_type: Option<&str>, fallback_url: Option<&str>) -> &'static str {
    let ct = content_type.unwrap_or("").to_ascii_lowercase();
    if ct.contains("webp") {
        "webp"
    } else if ct.contains("jpeg") || ct.contains("jpg") {
        "jpg"
    } else if ct.contains("gif") {
        "gif"
    } else if fallback_url
        .unwrap_or("")
        .to_ascii_lowercase()
        .split('?')
        .next()
        .unwrap_or("")
        .ends_with(".webp")
    {
        "webp"
    } else if fallback_url
        .unwrap_or("")
        .to_ascii_lowercase()
        .split('?')
        .next()
        .unwrap_or("")
        .ends_with(".jpg")
        || fallback_url
            .unwrap_or("")
            .to_ascii_lowercase()
            .split('?')
            .next()
            .unwrap_or("")
            .ends_with(".jpeg")
    {
        "jpg"
    } else {
        "png"
    }
}

async fn download_image_to_asset(
    client: &reqwest::Client,
    app: &AppHandle,
    id: &str,
    url: &str,
) -> Result<String, String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("download image from {url}: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        return Err(format!("download image from {url}: HTTP {status}"));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .map(str::to_string);
    let ext = ext_from_content_type(
        content_type.as_deref(),
        Some(url),
    );
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("read downloaded image from {url}: {e}"))?;
    save_image_bytes(app, id, ext, &bytes)
}

fn save_base64_to_asset(app: &AppHandle, id: &str, raw: &str, ext: &str) -> Result<String, String> {
    let bytes = decode_base64_image(raw)?;
    save_image_bytes(app, id, ext, &bytes)
}

async fn save_output_reference(
    client: &reqwest::Client,
    app: &AppHandle,
    id: &str,
    reference: &str,
) -> Result<String, String> {
    if reference.starts_with("data:image/") {
        let ext = ext_from_content_type(reference.split(';').next(), None);
        save_base64_to_asset(app, id, reference, ext)
    } else if reference.starts_with("http://") || reference.starts_with("https://") {
        download_image_to_asset(client, app, id, reference).await
    } else {
        Err(format!("unsupported image output reference: {reference}"))
    }
}

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

/// Returns the API key to use for the given protocol.
///
/// Priority: explicit `api_key` arg → env var → empty string for comfyui/keyless.
/// The public command turns an empty key into a real error for keyed providers.
fn resolve_image_key(protocol: &str, api_key: &Option<String>) -> String {
    if let Some(k) = api_key {
        if !k.is_empty() {
            return k.clone();
        }
    }
    match protocol {
        "comfyui" => String::new(),
        "replicate" => std::env::var("REPLICATE_API_TOKEN").unwrap_or_default(),
        "openai" => std::env::var("OPENAI_API_KEY").unwrap_or_default(),
        "custom" => std::env::var("SHUGU_CUSTOM_IMAGE_KEY").unwrap_or_default(),
        "minimax" => std::env::var("MINIMAX_API_KEY").unwrap_or_default(),
        "stability" => std::env::var("STABILITY_API_KEY").unwrap_or_default(),
        _ => std::env::var("SHUGU_CUSTOM_IMAGE_KEY").unwrap_or_default(),
    }
}

// ---------------------------------------------------------------------------
// Ratio → size mapping
// ---------------------------------------------------------------------------

fn openai_image_size(model: &str, ratio: &str) -> &'static str {
    let model = model.trim();
    if model.starts_with("gpt-image-2") {
        return match ratio {
            "16:9" => "1536x864",
            "9:16" => "864x1536",
            "4:3" => "1536x1152",
            "3:4" => "1152x1536",
            _ => "1024x1024",
        };
    }
    if model.starts_with("gpt-image-") || model == "chatgpt-image-latest" {
        return match ratio {
            "16:9" | "4:3" => "1536x1024",
            "9:16" | "3:4" => "1024x1536",
            _ => "1024x1024",
        };
    }
    if model == "dall-e-2" {
        return "1024x1024";
    }
    match ratio {
        "16:9" | "4:3" => "1792x1024",
        "9:16" | "3:4" => "1024x1792",
        _ => "1024x1024",
    }
}

fn ratio_to_comfy_dimensions(ratio: &str) -> (u32, u32) {
    match ratio {
        "16:9" => (1024, 576),
        "9:16" => (576, 1024),
        "4:3" => (896, 672),
        "3:4" => (672, 896),
        _ => (768, 768),
    }
}

fn fallback_id() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("img-{}", ms)
}

fn compact_error_text(raw: &str, max: usize) -> String {
    let clean = raw.trim().replace(['\r', '\n', '\t'], " ");
    let count = clean.chars().count();
    if count <= max {
        clean
    } else {
        format!("{}...", clean.chars().take(max).collect::<String>())
    }
}

async fn http_error_message(protocol: &str, action: &str, resp: reqwest::Response) -> String {
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if text.trim().is_empty() {
        format!("{protocol}: {action} failed with HTTP {status}")
    } else {
        format!(
            "{protocol}: {action} failed with HTTP {status}: {}",
            compact_error_text(&text, 600)
        )
    }
}

fn require_key(protocol: &str, api_key: String) -> Result<String, String> {
    if api_key.trim().is_empty() {
        Err(format!(
            "{protocol}: missing API key. Configure it in Settings > Connections or set the matching environment variable."
        ))
    } else {
        Ok(api_key)
    }
}

fn require_base_url(protocol: &str, base_url: &str) -> Result<String, String> {
    let base = base_url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        Err(format!("{protocol}: missing baseUrl in provider configuration"))
    } else {
        Ok(base)
    }
}

// ---------------------------------------------------------------------------
// Per-protocol helpers
// ---------------------------------------------------------------------------

async fn call_comfyui(
    client: &reqwest::Client,
    app: &AppHandle,
    base_url: &str,
    args: &ImageGenerateArgs,
    fallback: &str,
) -> Result<ImageJob, String> {
    let base = require_base_url("comfyui", base_url)?;
    let seed = args.seed.unwrap_or(42);
    let steps = args.steps.unwrap_or(20);
    let cfg = args.guidance.unwrap_or(7.0);
    let (width, height) = ratio_to_comfy_dimensions(&args.ratio);
    let ckpt = if args.model.trim().is_empty() {
        "v1-5-pruned-emaonly.safetensors"
    } else {
        args.model.as_str()
    };

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
            "4": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": ckpt } },
            "5": { "class_type": "EmptyLatentImage", "inputs": { "width": width, "height": height, "batch_size": 1 } },
            "6": { "class_type": "CLIPTextEncode", "inputs": { "text": args.prompt, "clip": ["4", 1] } },
            "7": { "class_type": "CLIPTextEncode", "inputs": { "text": args.negative.as_deref().unwrap_or(""), "clip": ["4", 1] } },
            "8": { "class_type": "VAEDecode", "inputs": { "samples": ["3", 0], "vae": ["4", 2] } },
            "9": { "class_type": "SaveImage", "inputs": { "filename_prefix": "shugu", "images": ["8", 0] } }
        }
    });

    let url = format!("{}/prompt", base);
    let resp = client
        .post(&url)
        .json(&graph)
        .send()
        .await
        .map_err(|e| format!("comfyui: cannot queue prompt at {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(http_error_message("comfyui", "queue prompt", resp).await);
    }
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("comfyui: invalid queue response: {e}"))?;
    let prompt_id = v["prompt_id"]
        .as_str()
        .ok_or_else(|| "comfyui: queue response did not include prompt_id".to_string())?
        .to_string();
    poll_comfyui_history(client, app, &base, &prompt_id, fallback).await
}

fn comfy_image_from_history(v: &Value, prompt_id: &str) -> Option<(String, String, String)> {
    let outputs = v.get(prompt_id)?.get("outputs")?.as_object()?;
    for node in outputs.values() {
        let images = node.get("images")?.as_array()?;
        for img in images {
            let filename = img.get("filename")?.as_str()?.to_string();
            let subfolder = img
                .get("subfolder")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let kind = img
                .get("type")
                .and_then(|x| x.as_str())
                .unwrap_or("output")
                .to_string();
            return Some((filename, subfolder, kind));
        }
    }
    None
}

async fn poll_comfyui_history(
    client: &reqwest::Client,
    app: &AppHandle,
    base_url: &str,
    prompt_id: &str,
    fallback: &str,
) -> Result<ImageJob, String> {
    let base = base_url.trim_end_matches('/');
    for _ in 0..45 {
        tokio::time::sleep(Duration::from_millis(900)).await;
        let url = format!("{}/history/{}", base, prompt_id);
        let Ok(resp) = client.get(&url).send().await else {
            continue;
        };
        if !resp.status().is_success() {
            continue;
        }
        let Ok(v) = resp.json::<Value>().await else {
            continue;
        };
        let Some((filename, subfolder, kind)) = comfy_image_from_history(&v, prompt_id) else {
            continue;
        };
        let view_url = format!(
            "{}/view?filename={}&subfolder={}&type={}",
            base,
            utf8_percent_encode(&filename, NON_ALPHANUMERIC),
            utf8_percent_encode(&subfolder, NON_ALPHANUMERIC),
            utf8_percent_encode(&kind, NON_ALPHANUMERIC),
        );
        let asset_id = format!("{}-{}", fallback, prompt_id);
        let result_url = download_image_to_asset(client, app, &asset_id, &view_url).await?;
        return Ok(ImageJob {
            id: prompt_id.to_string(),
            status: "done".into(),
            result_url: Some(result_url),
        });
    }
    Err(format!(
        "comfyui: prompt {prompt_id} did not finish within 40 seconds"
    ))
}

async fn call_replicate(
    client: &reqwest::Client,
    app: &AppHandle,
    base_url: &str,
    model: &str,
    args: &ImageGenerateArgs,
    api_key: &str,
    fallback: &str,
) -> Result<ImageJob, String> {
    let base = require_base_url("replicate", base_url)?;
    let input = serde_json::json!({
        "prompt": args.prompt,
        "negative_prompt": args.negative.as_deref().unwrap_or(""),
        "aspect_ratio": args.ratio,
        "num_outputs": 1,
        "num_inference_steps": args.steps.unwrap_or(20),
        "guidance_scale": args.guidance.unwrap_or(7.5),
        "seed": args.seed.unwrap_or(42)
    });
    let (url, body) = replicate_create_request(&base, model, input)?;

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Prefer", "wait=60")
        .header("Cancel-After", "5m")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("replicate: cannot create prediction at {url}: {e}"))?;

    if !resp.status().is_success() {
        return Err(http_error_message("replicate", "create prediction", resp).await);
    }

    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("replicate: invalid prediction response: {e}"))?;
    resolve_replicate_prediction(client, app, &base, &api_key, v, fallback).await
}

fn replicate_create_request(
    base: &str,
    model: &str,
    input: Value,
) -> Result<(String, Value), String> {
    let model = model.trim();
    if model.is_empty() {
        return Err(
            "replicate: missing model. Use owner/model, owner/model:version, or a version id."
                .to_string(),
        );
    }

    if let Some(rest) = model.strip_prefix("deployments/") {
        let mut parts = rest.split('/');
        let owner = parts.next().unwrap_or("");
        let name = parts.next().unwrap_or("");
        if owner.is_empty() || name.is_empty() || parts.next().is_some() {
            return Err("replicate: deployment model must be deployments/{owner}/{name}".to_string());
        }
        let url = format!(
            "{}/v1/deployments/{}/{}/predictions",
            base,
            utf8_percent_encode(owner, NON_ALPHANUMERIC),
            utf8_percent_encode(name, NON_ALPHANUMERIC),
        );
        return Ok((url, serde_json::json!({ "input": input })));
    }

    if model.contains('/') && !model.contains(':') {
        let mut parts = model.split('/');
        let owner = parts.next().unwrap_or("");
        let name = parts.next().unwrap_or("");
        if owner.is_empty() || name.is_empty() || parts.next().is_some() {
            return Err("replicate: model must be owner/model or owner/model:version".to_string());
        }
        let url = format!(
            "{}/v1/models/{}/{}/predictions",
            base,
            utf8_percent_encode(owner, NON_ALPHANUMERIC),
            utf8_percent_encode(name, NON_ALPHANUMERIC),
        );
        return Ok((url, serde_json::json!({ "input": input })));
    }

    Ok((
        format!("{}/v1/predictions", base),
        serde_json::json!({
            "version": model,
            "input": input
        }),
    ))
}

async fn resolve_replicate_prediction(
    client: &reqwest::Client,
    app: &AppHandle,
    base: &str,
    api_key: &str,
    mut prediction: Value,
    fallback: &str,
) -> Result<ImageJob, String> {
    let id = prediction["id"]
        .as_str()
        .unwrap_or(fallback)
        .to_string();

    for attempt in 0..80 {
        let status = prediction["status"].as_str().unwrap_or("unknown");
        match status {
            "succeeded" => {
                let result_url = save_replicate_output(client, app, &id, &prediction).await?;
                return Ok(ImageJob {
                    id,
                    status: "done".into(),
                    result_url: Some(result_url),
                });
            }
            "failed" | "canceled" => {
                return Err(format!(
                    "replicate: prediction {id} {status}: {}",
                    replicate_prediction_error(&prediction)
                ));
            }
            _ => {}
        }

        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(1500)).await;
        }

        let get_url = prediction["urls"]["get"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| format!("{}/v1/predictions/{}", base, id));
        let resp = client
            .get(&get_url)
            .header("Authorization", format!("Bearer {}", api_key))
            .send()
            .await
            .map_err(|e| format!("replicate: cannot poll prediction {id}: {e}"))?;
        if !resp.status().is_success() {
            return Err(http_error_message("replicate", "poll prediction", resp).await);
        }
        prediction = resp
            .json()
            .await
            .map_err(|e| format!("replicate: invalid poll response for {id}: {e}"))?;
    }

    Err(format!(
        "replicate: prediction {id} did not finish within 2 minutes"
    ))
}

fn replicate_prediction_error(prediction: &Value) -> String {
    prediction["error"]
        .as_str()
        .map(|s| compact_error_text(s, 400))
        .or_else(|| {
            prediction["logs"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .map(|s| compact_error_text(s, 400))
        })
        .unwrap_or_else(|| "no error details returned".to_string())
}

async fn save_replicate_output(
    client: &reqwest::Client,
    app: &AppHandle,
    id: &str,
    prediction: &Value,
) -> Result<String, String> {
    let output = prediction
        .get("output")
        .ok_or_else(|| "replicate: succeeded prediction has no output".to_string())?;
    let reference = find_image_reference(output)
        .ok_or_else(|| "replicate: output did not include an image URL or data URL".to_string())?;
    save_output_reference(client, app, id, &reference).await
}

fn find_image_reference(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => {
            if s.starts_with("http://") || s.starts_with("https://") || s.starts_with("data:image/") {
                Some(s.to_string())
            } else {
                None
            }
        }
        Value::Array(items) => items.iter().find_map(find_image_reference),
        Value::Object(map) => map
            .get("url")
            .and_then(find_image_reference)
            .or_else(|| map.values().find_map(find_image_reference)),
        _ => None,
    }
}

async fn call_openai_images(
    client: &reqwest::Client,
    app: &AppHandle,
    base_url: &str,
    model: &str,
    args: &ImageGenerateArgs,
    api_key: &str,
    protocol: &str,
    fallback: &str,
) -> Result<ImageJob, String> {
    let base = require_base_url(protocol, base_url)?;
    let size = openai_image_size(model, &args.ratio);
    let body = serde_json::json!({
        "model": model,
        "prompt": args.prompt,
        "n": 1,
        "size": size
    });

    let url = if base.ends_with("/v1") {
        format!("{}/images/generations", base)
    } else {
        format!("{}/v1/images/generations", base)
    };

    let mut req = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body);
    if !api_key.trim().is_empty() {
        req = req.header("Authorization", format!("Bearer {}", api_key));
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("{protocol}: cannot create image at {url}: {e}"))?;

    if !resp.status().is_success() {
        return Err(http_error_message(protocol, "create image", resp).await);
    }

    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("{protocol}: invalid image response: {e}"))?;
    let result_url = if let Some(b64) = v["data"][0]["b64_json"].as_str() {
        save_base64_to_asset(app, fallback, b64, "png")?
    } else if let Some(url) = v["data"][0]["url"].as_str() {
        download_image_to_asset(client, app, fallback, url).await?
    } else {
        return Err(format!("{protocol}: response did not include b64_json or url"));
    };
    Ok(ImageJob {
        id: fallback.to_string(),
        status: "done".into(),
        result_url: Some(result_url),
    })
}

async fn call_minimax_images(
    client: &reqwest::Client,
    app: &AppHandle,
    base_url: &str,
    model: &str,
    args: &ImageGenerateArgs,
    api_key: &str,
    fallback: &str,
) -> Result<ImageJob, String> {
    let base = require_base_url("minimax", base_url)?;
    let body = serde_json::json!({
        "model": if model.trim().is_empty() { "image-01" } else { model },
        "prompt": args.prompt,
        "aspect_ratio": args.ratio,
        "response_format": "base64"
    });

    let url = if base.ends_with("/image_generation") {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{}/image_generation", base)
    } else {
        format!("{}/v1/image_generation", base)
    };

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("minimax: cannot create image at {url}: {e}"))?;

    if !resp.status().is_success() {
        return Err(http_error_message("minimax", "create image", resp).await);
    }

    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("minimax: invalid image response: {e}"))?;

    let result_url = if let Some(b64) = v
        .pointer("/data/image_base64")
        .and_then(|x| x.as_array())
        .and_then(|arr| arr.first())
        .and_then(|x| x.as_str())
    {
        save_base64_to_asset(app, fallback, b64, "jpg")?
    } else if let Some(url) = v
        .pointer("/data/image_urls")
        .and_then(|x| x.as_array())
        .and_then(|arr| arr.first())
        .and_then(|x| x.as_str())
    {
        download_image_to_asset(client, app, fallback, url).await?
    } else {
        return Err("minimax: response did not include image_base64 or image_urls".to_string());
    };

    Ok(ImageJob {
        id: fallback.to_string(),
        status: "done".into(),
        result_url: Some(result_url),
    })
}

async fn call_stability(
    client: &reqwest::Client,
    app: &AppHandle,
    base_url: &str,
    args: &ImageGenerateArgs,
    api_key: &str,
    fallback: &str,
) -> Result<ImageJob, String> {
    let base = require_base_url("stability", base_url)?;
    let body = serde_json::json!({
        "text_prompts": [{ "text": args.prompt, "weight": 1.0 }],
        "cfg_scale": args.guidance.unwrap_or(7.0),
        "steps": args.steps.unwrap_or(30),
        "seed": args.seed.unwrap_or(0)
    });

    let url = format!(
        "{}/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image",
        base
    );
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("content-type", "application/json")
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("stability: cannot create image at {url}: {e}"))?;

    if !resp.status().is_success() {
        return Err(http_error_message("stability", "create image", resp).await);
    }

    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("stability: invalid image response: {e}"))?;
    let result_url = v["artifacts"][0]["base64"]
        .as_str()
        .ok_or_else(|| "stability: response did not include artifacts[0].base64".to_string())
        .and_then(|b64| save_base64_to_asset(app, fallback, b64, "png"))?;
    Ok(ImageJob {
        id: fallback.to_string(),
        status: "done".into(),
        result_url: Some(result_url),
    })
}

// ---------------------------------------------------------------------------
// Public command
// ---------------------------------------------------------------------------

/// Provider-agnostic image generation dispatcher.
///
/// Dispatches to ComfyUI, Replicate, Stability AI, OpenAI DALL-E, or an
/// OpenAI-compatible backend based on the `protocol` field.
///
/// This command returns `Err` for missing credentials, provider failures,
/// invalid responses, and timeouts. The frontend should surface the error
/// instead of inventing a placeholder generation.
///
/// Env vars per protocol:
///   - comfyui   — `COMFYUI_URL` (base URL, not a key)
///   - replicate — `REPLICATE_API_TOKEN`
///   - openai    — `OPENAI_API_KEY`
///   - minimax   — `MINIMAX_API_KEY`
///   - stability — `STABILITY_API_KEY`
///   - custom    — `SHUGU_CUSTOM_IMAGE_KEY`
#[tauri::command]
pub async fn image_generate(app: AppHandle, args: ImageGenerateArgs) -> Result<ImageJob, String> {
    // Reserved fields accepted for forward-compatibility; silence unused warnings.
    let _ = &args.style;

    let fid = fallback_id();
    let client = reqwest::Client::new();
    let protocol = args.protocol.as_str();
    let api_key = resolve_image_key(protocol, &args.api_key);

    match protocol {
        "comfyui" => {
            let base = if args.base_url.is_empty() {
                std::env::var("COMFYUI_URL").unwrap_or_else(|_| "http://127.0.0.1:8188".to_string())
            } else {
                args.base_url.clone()
            };
            call_comfyui(&client, &app, &base, &args, &fid).await
        }
        "replicate" => {
            let api_key = require_key("replicate", api_key)?;
            call_replicate(&client, &app, &args.base_url, &args.model, &args, &api_key, &fid).await
        }
        "openai" => {
            let api_key = require_key(protocol, api_key)?;
            call_openai_images(
                &client,
                &app,
                &args.base_url,
                &args.model,
                &args,
                &api_key,
                protocol,
                &fid,
            )
            .await
        }
        "custom" => {
            call_openai_images(
                &client,
                &app,
                &args.base_url,
                &args.model,
                &args,
                &api_key,
                protocol,
                &fid,
            )
            .await
        }
        "minimax" => {
            let api_key = require_key("minimax", api_key)?;
            call_minimax_images(
                &client,
                &app,
                &args.base_url,
                &args.model,
                &args,
                &api_key,
                &fid,
            )
            .await
        }
        "stability" => {
            let api_key = require_key("stability", api_key)?;
            call_stability(&client, &app, &args.base_url, &args, &api_key, &fid).await
        }
        other => Err(format!("image: unsupported protocol '{other}'")),
    }
}
