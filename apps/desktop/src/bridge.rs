use dirs;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// Read an API key for a provider from ~/.zharness/agent/auth.json.
fn read_api_key(provider: &str) -> Option<String> {
	let home = dirs::home_dir()?;
	let auth_path = PathBuf::from(&home)
		.join(".zharness")
		.join("agent")
		.join("auth.json");
	let raw = std::fs::read_to_string(&auth_path).ok()?;
	let parsed: Value = serde_json::from_str(&raw).ok()?;
	let key = parsed.get(provider)?.get("key")?.as_str()?.to_string();
	if key.is_empty() {
		None
	} else {
		Some(key)
	}
}

fn log_file(msg: &str) {
	use std::io::Write;
	/// Bridge log caps. The log is append-only across app runs and previously
	/// grew unbounded (940 MB observed) because sidecar event payloads were
	/// written verbatim on every stdout line.
	const LOG_ROTATE_BYTES: u64 = 64 * 1024 * 1024;
	const LOG_MAX_LINE_BYTES: usize = 2000;
	let path = "/tmp/zharness-gui-bridge.log";
	// Rotate: keep a single previous generation (.old) instead of growing
	// forever. Rename can fail while another thread holds the file open —
	// ignored, the next call retries.
	if let Ok(meta) = std::fs::metadata(path) {
		if meta.len() > LOG_ROTATE_BYTES {
			let old = format!("{}.old", path);
			let _ = std::fs::remove_file(&old);
			let _ = std::fs::rename(path, &old);
		}
	}
	if let Ok(mut f) = std::fs::OpenOptions::new()
		.create(true)
		.append(true)
		.open(path)
	{
		// Truncate oversized lines — event payloads dominate the volume and a
		// head is enough to identify them.
		if msg.len() > LOG_MAX_LINE_BYTES {
			let mut end = LOG_MAX_LINE_BYTES;
			while end > 0 && !msg.is_char_boundary(end) {
				end -= 1;
			}
			let _ = writeln!(f, "{}… [truncated, {} bytes total]", &msg[..end], msg.len());
		} else {
			let _ = writeln!(f, "{}", msg);
		}
	}
}

/// Verbose per-line sidecar stdout logging. Off by default: it sat on the
/// event hot path (one file open/append/close per streamed line) and was the
/// main source of log growth. Enable with ZHARNESS_BRIDGE_VERBOSE=1 to debug.
fn bridge_verbose() -> bool {
	static VERBOSE: OnceLock<bool> = OnceLock::new();
	*VERBOSE.get_or_init(|| {
		std::env::var("ZHARNESS_BRIDGE_VERBOSE")
			.map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
			.unwrap_or(false)
	})
}

fn find_node() -> Option<String> {
	// Check ZHARNESS_NODE env var first.
	if let Ok(node) = std::env::var("ZHARNESS_NODE") {
		if std::path::Path::new(&node).exists() {
			return Some(node);
		}
	}
	// Try nvm first — nvm versions are usually newer and have node:sqlite.
	if let Some(home) = dirs::home_dir() {
		let nvm_node = format!("{}/.nvm/versions/node", home.to_string_lossy());
		if let Ok(entries) = std::fs::read_dir(&nvm_node) {
			let mut versions: Vec<_> = entries.filter_map(|e| e.ok()).collect();
			versions.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
			for v in versions {
				let node_path = v.path().join("bin/node");
				if node_path.exists() {
					return Some(node_path.to_string_lossy().to_string());
				}
			}
		}
	}
	// Check common locations (homebrew, system).
	let candidates = [
		"/opt/homebrew/bin/node",
		"/usr/local/bin/node",
		"/usr/bin/node",
	];
	for c in &candidates {
		if std::path::Path::new(c).exists() {
			return Some(c.to_string());
		}
	}
	// Fallback to "node" and hope PATH works.
	Some("node".to_string())
}
/// Run the user's login shell once and capture the PATH it would set in an
/// interactive terminal, so the GUI-launched sidecar (which inherits launchd's
/// minimal PATH and never sources ~/.zprofile / ~/.bash_profile) still finds
/// tools the user installed via homebrew/cargo/nvm/etc.
///
/// Runs `<shell> -lic 'printf %s "$PATH"'` with stdin wired to /dev/null and a
/// hard timeout, so a misbehaving rc file can't hang the app. The result is
/// cached per process via OnceLock.
fn capture_login_shell_path() -> Option<String> {
	// Prefer the user's configured login shell, then common fallbacks.
	let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty());
	let candidates: Vec<String> = match shell {
		Some(s) => vec![s, "/bin/zsh".to_string(), "/bin/bash".to_string()],
		None => vec!["/bin/zsh".to_string(), "/bin/bash".to_string()],
	};

	for shell in candidates {
		if !PathBuf::from(&shell).exists() {
			continue;
		}
		match run_shell_capture_path(&shell) {
			Some(path) if !path.trim().is_empty() => return Some(path),
			_ => continue,
		}
	}
	None
}

/// Spawn `<shell> -lic 'printf %s "$PATH"'` with a timeout and return its
/// trimmed stdout. Returns None on timeout, non-zero exit, or empty output.
fn run_shell_capture_path(shell: &str) -> Option<String> {
	const TIMEOUT: Duration = Duration::from_secs(3);

	let (tx, rx) = std::sync::mpsc::channel();
	let shell = shell.to_string();
	thread::spawn(move || {
		let result = (|| {
			let output = Command::new(&shell)
				.args(["-lic", "printf %s \"$PATH\""])
				.stdin(Stdio::null())
				.stdout(Stdio::piped())
				.stderr(Stdio::piped())
				.output()
				.ok()?;
			if !output.status.success() {
				return None;
			}
			let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
			if path.is_empty() {
				None
			} else {
				Some(path)
			}
		})();
		let _ = tx.send(result);
	});

	match rx.recv_timeout(TIMEOUT) {
		Ok(value) => value,
		Err(_) => None, // timed out — give up on this shell
	}
}

/// Expand `~` and unify separators to the platform-native form.
///
/// The result keys the sidecar map, the active-workspace map and the
/// `_cwd` event tags, so the SAME directory must always normalize to the
/// SAME string. The webview expands `~` itself (mixed separators on
/// Windows: `C:\Users\x/.zharness/main`) while workspace meta.json cwd
/// values are backslash-native; mixed keys used to spawn a SECOND
/// sidecar for ~/.zharness/main — without `--main`, so its scheduler
/// engine served the main dir as a plain workspace scope and
/// main-scoped tasks failed run-now with "belongs to another project
/// (or main)".
fn normalize_cwd(cwd: String) -> String {
	let cwd = if cwd.starts_with('~') {
		match dirs::home_dir() {
			Some(home) => format!("{}{}", home.to_string_lossy(), &cwd[1..]),
			None => cwd,
		}
	} else {
		cwd
	};
	if cfg!(windows) {
		cwd.replace('/', "\\")
	} else {
		cwd
	}
}

/// Path equality tolerant of separator and case differences (Windows
/// accepts both `/` and `\` and is case-insensitive). The persistent
/// Chat cwd arrives in different spellings — `~` expanded by the
/// webview with forward slashes, meta.json with backslashes — and a
/// strict string compare used to drop the `--main` flag for some of
/// them, silently disabling the main-scope scheduler engine.
fn path_equals(a: &str, b: &str) -> bool {
	let norm = |p: &str| p.replace('\\', "/").to_lowercase();
	norm(a) == norm(b)
}

/// Resolve the PATH to pass to sidecars: the login-shell PATH if we could
/// capture one, otherwise the process's inherited PATH. Cached per process.
fn resolve_shell_path() -> String {
	static CACHED: OnceLock<Option<String>> = OnceLock::new();
	let cached = CACHED.get_or_init(capture_login_shell_path);
	match cached {
		Some(path) => path.clone(),
		None => std::env::var("PATH").unwrap_or_default(),
	}
}

fn resolve_zharness_command(app: &AppHandle) -> (String, Vec<String>) {
	// 1. ZHARNESS_BIN env var — explicit override (any executable, including a
	//    manually-built `dist/zharness` Bun binary).
	if let Ok(bin) = std::env::var("ZHARNESS_BIN") {
		let parts: Vec<&str> = bin.split_whitespace().collect();
		if parts.len() >= 2 {
			return (
				parts[0].to_string(),
				parts[1..]
					.iter()
					.map(|s| s.to_string())
					.chain(["--mode".to_string(), "rpc".to_string()])
					.collect(),
			);
		}
		return (
			parts[0].to_string(),
			vec!["--mode".to_string(), "rpc".to_string()],
		);
	}

	// 2. Packaged binary bundled via tauri.conf.json `bundle.resources`.
	//    The resource_dir is the runtime location of bundled assets
	//    (e.g. inside the .app bundle on macOS). When present, this makes
	//    the desktop app self-contained — no Node.js required.
	//    On Windows the binary has a .exe extension.
	//    Skipped in debug builds: in dev the resource_dir points at
	//    target/debug/ where a stale dist/zharness may exist from a prior
	//    `build:binary`, which can hang the sidecar.
	if !cfg!(debug_assertions) {
		if let Ok(resource_dir) = app.path().resource_dir() {
			let zharness_bin = resource_dir.join(if cfg!(windows) {
				"zharness.exe"
			} else {
				"zharness"
			});
			if zharness_bin.exists() {
				log_file(&format!(
					"resolve_zharness_command: using bundled binary at {}",
					zharness_bin.display()
				));
				return (
					zharness_bin.to_string_lossy().to_string(),
					vec!["--mode".to_string(), "rpc".to_string()],
				);
			}
		}
	}

	// 3. Dev fallback: run `node dist/src/cli.js` from the source tree.
	let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("..")
		.join("..");
	let cli_js = project_root.join("dist").join("src").join("cli.js");
	let register_script = project_root.join("scripts").join("register-module-resolver.mjs");
	// Node >= 20 deprecated `--loader`, and on recent Windows builds (observed
	// on v24) passing a plain path to `--loader` / `--import` crashes with
	// ERR_UNSUPPORTED_ESM_URL_SCHEME because the path is parsed as a URL.
	// Pass the bootstrap as a proper file:// URL via `--import`; the bootstrap
	// registers the actual hook by relative path. The main entry stays a plain
	// path (Node normalizes it correctly).
	let register_url = url::Url::from_file_path(&register_script)
		.map(|u| u.to_string())
		.unwrap_or_else(|_| register_script.to_string_lossy().replace('\\', "/"));
	let node = find_node().unwrap_or_else(|| "node".to_string());
	log_file(&format!(
		"resolve_zharness_command: dev fallback, node={}, cli_js={}, register={}",
		node,
		cli_js.display(),
		register_url
	));
	(
		node,
		vec![
			"--import".to_string(),
			register_url,
			cli_js.to_string_lossy().to_string(),
			"--mode".to_string(),
			"rpc".to_string(),
		],
	)
}

/// Sidecar entry: the process + which windows are using it.
struct SidecarEntry {
	child: Child,
	stdin: ChildStdin,
}

/// Releases a `spawning` slot on drop, so a failed spawn (process dies before
/// responding, spawn error) never leaves the cwd permanently "in flight".
struct SpawnSlotGuard<'a> {
	spawning: &'a Mutex<HashSet<String>>,
	cwd: String,
}

impl Drop for SpawnSlotGuard<'_> {
	fn drop(&mut self) {
		if let Ok(mut set) = self.spawning.lock() {
			set.remove(&self.cwd);
		}
	}
}

pub struct BridgeState {
	/// Sidecars keyed by cwd.
	sidecars: Mutex<HashMap<String, SidecarEntry>>,
	/// Active cwd per window label.
	active: Mutex<HashMap<String, String>>,
	/// cwds that are currently being intentionally restarted by
	/// `restart_sidecar`. The auto-restart path in the GUI checks this
	/// before respawning a sidecar whose exit it observed, so the
	/// user-initiated restart doesn't get clobbered by a race.
	restarting: Mutex<HashSet<String>>,
	/// cwds whose sidecar spawn is currently in flight: between
	/// `Command::spawn` and the blocking first-response read the sidecar is
	/// not yet in the `sidecars` map, so a concurrent `init_sidecar` for the
	/// same cwd cannot see it and used to spawn a duplicate process.
	spawning: Mutex<HashSet<String>>,
}

impl Default for BridgeState {
	fn default() -> Self {
		Self {
			sidecars: Mutex::new(HashMap::new()),
			active: Mutex::new(HashMap::new()),
			restarting: Mutex::new(HashSet::new()),
			spawning: Mutex::new(HashSet::new()),
		}
	}
}

/// Kill and remove the sidecar for a specific cwd.
pub fn kill_sidecar_for_cwd(state: &BridgeState, cwd: &str) {
	// Sidecar keys are normalized at spawn time — normalize the lookup so
	// callers passing a differently-spelled path still hit the entry.
	let key = normalize_cwd(cwd.to_string());
	log_file(&format!("kill_sidecar_for_cwd: cwd={} (key={})", cwd, key));
	let mut sidecars = state.sidecars.lock().unwrap();
	if let Some(mut sidecar) = sidecars.remove(&key) {
		let _ = sidecar.child.kill();
		let _ = sidecar.child.wait();
		log_file(&format!("kill_sidecar_for_cwd: killed sidecar for {}", key));
	}
}

/// Kill all sidecars for a given window (by active cwd).
pub fn kill_sidecar_for_window(state: &BridgeState, window_label: &str) {
	let cwd = {
		let active = state.active.lock().unwrap();
		active.get(window_label).cloned()
	};
	if let Some(cwd) = cwd {
		// Remove this window from active map.
		{
			let mut active = state.active.lock().unwrap();
			active.remove(window_label);
		}
		// Check if any other window is using this sidecar.
		let still_in_use = {
			let active = state.active.lock().unwrap();
			active.values().any(|c| c == &cwd)
		};
		if !still_in_use {
			kill_sidecar_for_cwd(state, &cwd);
		}
	}
}

/// Send a fire-and-forget JSON-RPC command (no args) to every running sidecar.
///
/// Provider credentials live in the shared `~/.zharness/agent/auth.json`, which is
/// edited out-of-band by `set_provider_api_key` / `remove_provider_api_key`.
/// Each sidecar caches credentials in memory and only re-reads the file on
/// explicit reload, so after such an edit we must tell every sidecar to reload
/// — otherwise a subsequent model switch resolves auth from the stale cache and
/// silently falls back to an environment-variable key (the wrong token).
fn broadcast_to_all_sidecars(state: &BridgeState, command_type: &str) {
	let line = serde_json::json!({ "id": uuid::Uuid::new_v4().to_string(), "type": command_type });
	let payload = match serde_json::to_string(&line) {
		Ok(s) => s,
		Err(e) => {
			log_file(&format!("broadcast_to_all_sidecars: serialize failed: {e}"));
			return;
		}
	};
	let mut sent = 0;
	let mut failed = Vec::new();
	{
		let mut sidecars = state.sidecars.lock().unwrap();
		for (cwd, sidecar) in sidecars.iter_mut() {
			// A write error here means the sidecar pipe is broken (process died).
			// The reader thread will reap it; we just log and move on.
			let result = (|| -> std::io::Result<()> {
				use std::io::Write;
				sidecar.stdin.write_all(payload.as_bytes())?;
				sidecar.stdin.write_all(b"\n")?;
				sidecar.stdin.flush()?;
				Ok(())
			})();
			if result.is_ok() {
				sent += 1;
			} else {
				failed.push(cwd.clone());
			}
		}
	}
	log_file(&format!(
		"broadcast_to_all_sidecars: command={} sent_to={} failed={:?}",
		command_type, sent, failed
	));
}

/// One-shot init: spawns sidecar for the calling window, sends get_state. Returns state JSON.
/// If a sidecar for this cwd already exists, just switches the active pointer (no restart).
/// `cwd` is the working directory for the zharness rpc process (the user's project).
#[tauri::command]
pub async fn init_sidecar(
	window: tauri::Window,
	state: tauri::State<'_, BridgeState>,
	cwd: Option<String>,
) -> Result<String, String> {
	let window_label = window.label().to_string();
	log_file(&format!("init_sidecar: start, window={}", window_label));

	let cwd = cwd.unwrap_or_else(|| {
		PathBuf::from(env!("CARGO_MANIFEST_DIR"))
			.join("..")
			.join("..")
			.canonicalize()
			.map(|p| p.to_string_lossy().to_string())
			.unwrap_or_else(|_| ".".to_string())
	});
	// Expand ~ and unify separators so the same directory always maps to
	// exactly one sidecar key (see normalize_cwd).
	let cwd = normalize_cwd(cwd);
	log_file(&format!("init_sidecar: cwd={}", cwd));

	// The persistent Chat workspace (~/.zharness/main) is auto-created on first
	// launch. It is the default workspace the desktop app boots into, so it
	// must always exist — unlike user-selected project directories, which are
	// expected to be present already.
	let is_persistent_chat = dirs::home_dir()
		.map(|home| path_equals(&cwd, &format!("{}/.zharness/main", home.to_string_lossy())))
		.unwrap_or(false);
	if is_persistent_chat && !std::path::Path::new(&cwd).is_dir() {
		log_file(&format!(
			"init_sidecar: creating persistent Chat workspace at {}",
			cwd
		));
		if let Err(e) = std::fs::create_dir_all(&cwd) {
			return Err(format!("Failed to create Chat workspace {}: {}", cwd, e));
		}
	}

	// Validate that the cwd directory exists before attempting to spawn.
	if !std::path::Path::new(&cwd).is_dir() {
		return Err(format!("Directory does not exist: {}", cwd));
	}

	// Check if sidecar for this cwd already exists.
	let mut already_running = {
		let sidecars = state.sidecars.lock().unwrap();
		sidecars.contains_key(&cwd)
	};

	// Claim the spawn slot. A concurrent init for the same cwd holds the slot
	// between spawn and its blocking first-response read — the sidecar is not
	// in the map yet, so the check above cannot see it. Instead of
	// double-spawning (two processes for one cwd; the loser leaks and its
	// reader thread keeps emitting duplicate events), wait for the in-flight
	// spawn to land in the map, then take the already-running fast path.
	let mut _spawn_slot: Option<SpawnSlotGuard<'_>> = None;
	if !already_running {
		let claimed = {
			let mut spawning = state.spawning.lock().unwrap();
			spawning.insert(cwd.clone())
		};
		if claimed {
			_spawn_slot = Some(SpawnSlotGuard {
				spawning: &state.spawning,
				cwd: cwd.clone(),
			});
		} else {
			log_file(&format!(
				"init_sidecar: spawn already in flight for cwd={}, waiting instead of double-spawning",
				cwd
			));
			let deadline = std::time::Instant::now() + Duration::from_secs(15);
			loop {
				{
					let sidecars = state.sidecars.lock().unwrap();
					if sidecars.contains_key(&cwd) {
						already_running = true;
						break;
					}
				}
				if std::time::Instant::now() >= deadline {
					log_file("init_sidecar: timed out waiting for in-flight spawn");
					break;
				}
				tokio::time::sleep(Duration::from_millis(50)).await;
			}
		}
	}

	if already_running {
		// Just switch active pointer.
		log_file(&format!(
			"init_sidecar: sidecar already running for cwd={}, switching active",
			cwd
		));
		{
			let mut active = state.active.lock().unwrap();
			active.insert(window_label.clone(), cwd.clone());
		}
		// Send get_state to get current state.
		let id = uuid::Uuid::new_v4().to_string();
		let cmd = serde_json::json!({ "id": id, "type": "get_state" });
		let line = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
		{
			let mut sidecars = state.sidecars.lock().unwrap();
			let sidecar = sidecars.get_mut(&cwd).ok_or("Sidecar disappeared")?;
			use std::io::Write;
			sidecar
				.stdin
				.write_all(line.as_bytes())
				.map_err(|e| format!("write: {e}"))?;
			sidecar
				.stdin
				.write_all(b"\n")
				.map_err(|e| format!("write nl: {e}"))?;
			sidecar.stdin.flush().map_err(|e| format!("flush: {e}"))?;
		}
		// We can't easily read the response synchronously here since the reader
		// thread is already consuming stdout. The frontend will get the state
		// via the rpc_response event. Return empty state.
		log_file("init_sidecar: switched, returning empty (state will come via event)");
		return Ok(serde_json::json!({}).to_string());
	}

	// Multi-sidecar: never kill the old sidecar on switch — it persists.
	// Just update the active workspace mapping for this window (done below).

	let (program, mut args) = resolve_zharness_command(window.app_handle());
	// When the workspace is the persistent Chat (~/.zharness/main), launch zharness
	// in main-agent mode so it initializes the soul file + long-term memory
	// scaffold and injects the main-agent guidelines into the system prompt.
	if is_persistent_chat {
		args.push("--main".to_string());
	}
	let mut cmd = Command::new(&program);
	cmd.args(&args);
	cmd.current_dir(&cwd);
	cmd.stdin(Stdio::piped());
	cmd.stdout(Stdio::piped());
	// Capture the sidecar's stderr so we can surface its real diagnostic when
	// it crashes immediately. Without this, a sidecar that emits its only
	// error to stderr (e.g. "Another main agent instance is already running")
	// fails invisibly inside the .app bundle — the GUI sees only an opaque
	// exit code with no clue about what went wrong.
	cmd.stderr(Stdio::piped());
	// GUI-launched processes inherit launchd's minimal PATH and never source the
	// user's shell rc files, so homebrew/cargo/nvm etc. would be missing. Capture
	// the login-shell PATH once and pass it to the sidecar explicitly.
	cmd.env("PATH", resolve_shell_path());
	log_file(&format!(
		"init_sidecar: sidecar PATH = {}",
		resolve_shell_path()
	));

	// Windows: suppress the console window for the sidecar process.
	#[cfg(windows)]
	{
		use std::os::windows::process::CommandExt;
		cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
	}

	log_file(&format!("init_sidecar: spawning {} {:?}", program, args));
	let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn: {e}"))?;
	log_file(&format!("init_sidecar: pid={:?}", child.id()));
	let stdin = child.stdin.take().ok_or("no stdin")?;
	let stdout = child.stdout.take().ok_or("no stdout")?;
	// Drain stderr in a background thread and stash the output. The thread
	// reads until EOF (which happens when the child closes its stderr end on
	// exit). When we surface the "sidecar exited" error below, we wait for the
	// child to exit, then join this thread to read its captured bytes.
	let stderr_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
	let stderr_handle = child.stderr.take().ok_or("no stderr")?;
	let stderr_buf_for_thread = Arc::clone(&stderr_buf);
	let stderr_thread = thread::spawn(move || {
		let mut reader = BufReader::new(stderr_handle);
		let mut bytes = Vec::new();
		let _ = reader.read_to_end(&mut bytes);
		if let Ok(mut s) = stderr_buf_for_thread.lock() {
			s.push_str(&String::from_utf8_lossy(&bytes));
		}
	});

	// Send get_state BEFORE storing stdin (so we can read the response synchronously).
	log_file("init_sidecar: sending get_state");
	let id = uuid::Uuid::new_v4().to_string();
	let cmd = serde_json::json!({ "id": id, "type": "get_state" });
	let line = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
	{
		use std::io::Write;
		let mut stdin_ref = &stdin;
		stdin_ref
			.write_all(line.as_bytes())
			.map_err(|e| format!("write: {e}"))?;
		stdin_ref
			.write_all(b"\n")
			.map_err(|e| format!("write nl: {e}"))?;
		stdin_ref.flush().map_err(|e| format!("flush: {e}"))?;
	}
	log_file("init_sidecar: get_state sent, reading first response");

	// Read first line from stdout synchronously (the get_state response).
	let mut reader = BufReader::new(stdout);
	let mut first_line = String::new();
	let bytes_read = reader
		.read_line(&mut first_line)
		.map_err(|e| format!("read response: {e}"))?;
	log_file(&format!("init_sidecar: first line = {}", first_line.trim()));

	// If we got EOF (0 bytes) the sidecar died immediately. Check exit status
	// to surface a meaningful error instead of storing a dead sidecar that
	// would cause "Broken pipe" on the next write.
	if bytes_read == 0 {
		// Reap the child (with a short timeout) so the OS closes its stderr
		// end and the stderr drain thread can finish. try_wait() first to
		// avoid blocking when the child has already exited.
		let exit_status = match child.try_wait() {
			Ok(Some(s)) => Some(s),
			_ => match child.wait() {
				Ok(s) => Some(s),
				Err(e) => {
					log_file(&format!("init_sidecar: wait failed: {e}"));
					None
				}
			},
		};
		// The stderr drain thread reads until EOF, which fires when the child
		// closes its stderr (i.e. when wait() above reaps it). Give it a
		// moment to land its buffered bytes, then join.
		let _ = stderr_thread.join();

		let exit_info = match exit_status {
			Some(status) => format!(" ({})", status),
			None => String::new(),
		};
		// Append the captured stderr so the user sees *why* the sidecar died,
		// not just that it did. Trim to the tail to keep the error payload
		// bounded — startup failures almost always live in the last few KB.
		const MAX_STDERR_TAIL: usize = 4096;
		let stderr_suffix = match stderr_buf.lock() {
			Ok(s) => {
				let trimmed = s.trim();
				if trimmed.is_empty() {
					String::new()
				} else {
					let tail = if trimmed.len() > MAX_STDERR_TAIL {
						let from = trimmed.len() - MAX_STDERR_TAIL;
						let safe_from = trimmed
							.char_indices()
							.map(|(i, _)| i)
							.find(|&i| i >= from)
							.unwrap_or(from);
						&trimmed[safe_from..]
					} else {
						trimmed
					};
					format!("\n--- sidecar stderr ---\n{}\n--- end ---", tail)
				}
			}
			Err(_) => String::new(),
		};
		return Err(format!(
			"Sidecar exited immediately without responding{}{}",
			exit_info, stderr_suffix
		));
	}

	// Parse the response.
	let state_data: Value = {
		let trimmed = first_line.trim();
		if trimmed.starts_with('{') {
			serde_json::from_str(trimmed).unwrap_or(Value::Null)
		} else {
			Value::Null
		}
	};

	// Store sidecar keyed by cwd.
	{
		let mut sidecars = state.sidecars.lock().unwrap();
		sidecars.insert(cwd.clone(), SidecarEntry { child, stdin });
	}

	// Set active cwd for this window.
	{
		let mut active = state.active.lock().unwrap();
		active.insert(window_label.clone(), cwd.clone());
	}

	// Spawn reader thread for subsequent events — emit to all windows that have this cwd active.
	let app = window.app_handle().clone();
	let reader_cwd = cwd.clone();
	std::thread::spawn(move || {
		log_file(&format!("reader thread: started for cwd={}", reader_cwd));
		for line in reader.lines() {
			match line {
				Ok(line) => {
					let trimmed = line.trim();
					if trimmed.is_empty() || !trimmed.starts_with('{') {
						continue;
					}
					let mut parsed: Value = match serde_json::from_str(trimmed) {
						Ok(v) => v,
						Err(_) => continue,
					};
					if bridge_verbose() {
						log_file(&format!("sidecar stdout [cwd={}]: {}", reader_cwd, trimmed));
					}
					// Emit to all windows that have this cwd as active.
					let app_ref = &app;
					let active = app_ref.state::<BridgeState>();
					let active_map = active.active.lock().unwrap();
					// Emit to ALL windows — include _cwd so frontend can filter.
					// This ensures events are received even when the workspace is not active.
					let etype = parsed
						.get("type")
						.and_then(|t| t.as_str())
						.unwrap_or("")
						.to_string();
					if etype == "response" {
						// Add _cwd to response for frontend routing.
						if let Some(obj) = parsed.as_object_mut() {
							obj.insert("_cwd".to_string(), Value::String(reader_cwd.clone()));
						}
					}
					for (label, _ac_cwd) in active_map.iter() {
						if let Some(win) = app_ref.get_webview_window(label) {
							match etype.as_str() {
								"response" => {
									let mut tagged = parsed.clone();
									if let Some(obj) = tagged.as_object_mut() {
										obj.insert(
											"_cwd".to_string(),
											Value::String(reader_cwd.clone()),
										);
									}
									let _ = win.emit("rpc_response", tagged);
								}
								"extension_ui_request" => {
									// Tag with _cwd so multi-window frontends can filter
									// requests to their own workspace's sidecar before
									// rendering a dialog (response routing goes through
									// rpc_command → this window's active sidecar).
									let mut tagged = parsed.clone();
									if let Some(obj) = tagged.as_object_mut() {
										obj.insert(
											"_cwd".to_string(),
											Value::String(reader_cwd.clone()),
										);
									}
									let _ = win.emit("extension_ui_request", tagged);
								}
								_ => {
									let mut tagged = parsed.clone();
									if let Some(obj) = tagged.as_object_mut() {
										obj.insert(
											"_cwd".to_string(),
											Value::String(reader_cwd.clone()),
										);
									}
									let _ = win.emit("rpc_event", tagged);
								}
							}
						}
					}
				}
				Err(e) => {
					log_file(&format!("reader error [cwd={}]: {e}", reader_cwd));
					break;
				}
			}
		}
		log_file(&format!("reader thread: EOF for cwd={}", reader_cwd));
		// Reap the dead sidecar: remove from the map and wait() to avoid a
		// zombie process lingering until the GUI exits. drop(stdin) first so
		// the write pipe is closed before we wait for exit.
		// If kill_sidecar_for_cwd already removed it, we get None and skip.
		{
			let app_ref = &app;
			let state = app_ref.state::<BridgeState>();
			let mut sidecars = state.sidecars.lock().unwrap();
			if let Some(mut entry) = sidecars.remove(&reader_cwd) {
				let pid = entry.child.id();
				drop(entry.stdin);
				let _ = entry.child.wait();
				log_file(&format!(
					"reader thread: reaped sidecar pid={:?} cwd={}",
					pid, reader_cwd
				));
			}
		}
		// Notify all windows — sidecar_exit includes cwd for frontend filtering.
		// Suppress the event while restart_sidecar is in the middle of
		// reaping the old child, so the GUI's auto-restart loop doesn't
		// race it. (Even if the event leaks through, the GUI restart loop
		// checks BridgeState.restarting client-side via a separate
		// query, but suppressing server-side is cleaner.)
		let app_ref = &app;
		let state_ref = app_ref.state::<BridgeState>();
		let suppress = state_ref.restarting.lock().unwrap().contains(&reader_cwd);
		let active = state_ref;
		let active_map = active.active.lock().unwrap();
		if !suppress {
			for (label, _ac_cwd) in active_map.iter() {
				if let Some(win) = app_ref.get_webview_window(label) {
					let _ = win.emit(
						"sidecar_exit",
						serde_json::json!({ "code": null, "cwd": reader_cwd }),
					);
				}
			}
		}
	});

	log_file("init_sidecar: done");
	Ok(state_data.to_string())
}

/// Kill the sidecar for `cwd` (if any) and respawn it. Used after writing
/// a new provider API key so the freshly-written `auth.json` is picked up
/// — the facade caches its model registry on startup and won't rescan it
/// mid-session.
///
/// Marks `cwd` in the `restarting` set first so the GUI's auto-restart
/// path (which fires when it observes a `sidecar_exit` event) doesn't
/// race us by spawning its own replacement sidecar while we're still
/// reaping the old one. Without this guard `init_sidecar` ends up taking
/// the "already running" fast-path and silently does nothing.
#[tauri::command]
pub async fn restart_sidecar(
	window: tauri::Window,
	state: tauri::State<'_, BridgeState>,
	cwd: String,
) -> Result<String, String> {
	// Normalize before keying the restarting/spawning sets and the map
	// lookups below — init_sidecar normalizes its own key, so an unmodified
	// cwd here would miss the entry and double-spawn after "restart".
	let cwd = normalize_cwd(cwd);
	log_file(&format!("restart_sidecar: start, cwd={}", cwd));
	// Claim the restart slot BEFORE killing so any sidecar_exit event
	// observed by the reader thread (which fires `kill_sidecar_for_cwd`
	// + emits the event) sees the flag and the GUI's auto-restart loop
	// no-ops.
	state.restarting.lock().unwrap().insert(cwd.clone());

	// Wait out any in-flight spawn for this cwd first (init_sidecar holds the
	// spawning slot until its sidecar lands in the map), otherwise the kill
	// below would miss the process being spawned and the restart would be a
	// no-op racing the original spawn.
	{
		let deadline = std::time::Instant::now() + Duration::from_secs(15);
		loop {
			let in_flight = state.spawning.lock().unwrap().contains(&cwd);
			if !in_flight || std::time::Instant::now() >= deadline {
				break;
			}
			tokio::time::sleep(Duration::from_millis(50)).await;
		}
	}

	// Stop the old sidecar for this cwd. Close its stdin first: the rpc
	// sidecar treats stdin EOF as a shutdown signal and exits gracefully,
	// which releases the main-agent lock in ~/.zharness/main via its exit
	// handlers. Only fall back to a hard kill if it ignores EOF —
	// TerminateProcess (Child::kill on Windows) skips those exit handlers
	// and orphans the lock dir with a fresh mtime, so the respawn below
	// would die for up to the lock's 15s staleness window with "Another
	// main agent instance is already running".
	let old_sidecar = {
		let mut sidecars = state.sidecars.lock().unwrap();
		sidecars.remove(&cwd)
	};
	if let Some(mut entry) = old_sidecar {
		let pid = entry.child.id();
		drop(entry.stdin);
		let deadline = std::time::Instant::now() + Duration::from_secs(5);
		let mut exited_gracefully = false;
		while std::time::Instant::now() < deadline {
			match entry.child.try_wait() {
				Ok(Some(_)) => {
					exited_gracefully = true;
					break;
				}
				Ok(None) => tokio::time::sleep(Duration::from_millis(50)).await,
				Err(_) => break,
			}
		}
		if !exited_gracefully {
			let _ = entry.child.kill();
		}
		let _ = entry.child.wait();
		log_file(&format!(
			"restart_sidecar: reaped old sidecar pid={} graceful={}",
			pid, exited_gracefully
		));
	}
	// Small grace period so the OS fully releases the process slot before we
	// reuse it. After a graceful exit the main-agent lock dir is already
	// removed by the sidecar's exit handlers, so the respawn below can take
	// it immediately; after the hard-kill fallback the CLI side retries its
	// lock acquisition through the 15s staleness window.
	tokio::time::sleep(Duration::from_millis(150)).await;
	// `init_sidecar` takes `tauri::State` by value (per the tauri
	// command-macro convention). Clone our handle so we can release
	// the `restarting` flag after it returns.
	let state_for_cleanup = state.clone();
	let result = init_sidecar(window, state, Some(cwd.clone())).await;
	state_for_cleanup.restarting.lock().unwrap().remove(&cwd);
	result
}

#[tauri::command]
pub fn stop_sidecar(
	window: tauri::Window,
	state: tauri::State<'_, BridgeState>,
) -> Result<(), String> {
	kill_sidecar_for_window(state.inner(), window.label());
	Ok(())
}

#[tauri::command]
pub fn rpc_command(
	window: tauri::Window,
	state: tauri::State<'_, BridgeState>,
	command: Value,
) -> Result<String, String> {
	let window_label = window.label();
	log_file(&format!("rpc_command [{}]: {}", window_label, command));
	let mut obj = command
		.as_object()
		.cloned()
		.ok_or("command must be an object")?;
	let id = if let Some(existing) = obj.get("id").and_then(|v| v.as_str()) {
		existing.to_string()
	} else {
		let id = uuid::Uuid::new_v4().to_string();
		obj.insert("id".to_string(), Value::String(id.clone()));
		id
	};
	let line = serde_json::to_string(&Value::Object(obj)).map_err(|e| e.to_string())?;
	log_file(&format!("rpc_command [{}] sending: {}", window_label, line));

	// Route to the active sidecar for this window.
	let cwd = {
		let active = state.active.lock().unwrap();
		active.get(window_label).cloned()
	};
	let cwd = cwd.ok_or("No active workspace for this window")?;

	let mut sidecars = state.sidecars.lock().unwrap();
	let sidecar = sidecars.get_mut(&cwd).ok_or("Sidecar is not running")?;
	sidecar
		.stdin
		.write_all(line.as_bytes())
		.map_err(|e| format!("write: {e}"))?;
	sidecar
		.stdin
		.write_all(b"\n")
		.map_err(|e| format!("write nl: {e}"))?;
	sidecar.stdin.flush().map_err(|e| format!("flush: {e}"))?;
	Ok(id)
}

/// Create a new workspace window with its own independent sidecar.
#[tauri::command]
pub async fn new_workspace(app: AppHandle) -> Result<String, String> {
	let label = format!("workspace-{}", uuid::Uuid::new_v4().simple());
	log_file(&format!("new_workspace: creating window={}", label));
	let _window = {
		let mut builder = tauri::WebviewWindowBuilder::new(
			&app,
			&label,
			tauri::WebviewUrl::App("index.html".into()),
		)
		.title("ZHarness")
		.inner_size(1200.0, 800.0)
		.min_inner_size(720.0, 480.0)
		.background_color(tauri::webview::Color(18, 18, 18, 255));
		#[cfg(target_os = "macos")]
		{
			builder = builder
				.title_bar_style(tauri::TitleBarStyle::Transparent)
				.hidden_title(true);
		}
		builder
			.build()
			.map_err(|e| format!("Failed to create window: {e}"))?
	};
	Ok(label)
}

/// List all workspaces from ~/.zharness/agent/workspaces/*/meta.json
#[tauri::command]
pub async fn list_workspaces() -> Result<Vec<Value>, String> {
	let home = dirs::home_dir().ok_or("HOME not set")?;
	let workspaces_dir = PathBuf::from(&home)
		.join(".zharness")
		.join("agent")
		.join("workspaces");

	if !workspaces_dir.exists() {
		return Ok(Vec::new());
	}

	let entries = std::fs::read_dir(&workspaces_dir).map_err(|e| format!("read_dir: {e}"))?;
	let mut workspaces: Vec<Value> = Vec::new();

	for entry in entries {
		let entry = entry.map_err(|e| format!("entry: {e}"))?;
		let meta_path = entry.path().join("meta.json");
		if !meta_path.exists() {
			continue;
		}
		let raw = match std::fs::read_to_string(&meta_path) {
			Ok(s) => s,
			Err(_) => continue,
		};
		let meta: Value = match serde_json::from_str(&raw) {
			Ok(v) => v,
			Err(_) => continue,
		};
		workspaces.push(meta);
	}

	// Sort by last_accessed_at descending
	workspaces.sort_by(|a, b| {
		let a_time = a
			.get("last_accessed_at")
			.and_then(|v| v.as_i64())
			.unwrap_or(0);
		let b_time = b
			.get("last_accessed_at")
			.and_then(|v| v.as_i64())
			.unwrap_or(0);
		b_time.cmp(&a_time)
	});

	Ok(workspaces)
}

/// Delete a workspace by its workspace_id — removes the workspace meta directory
/// and kills any running sidecar for that workspace's cwd.
#[tauri::command]
pub async fn delete_workspace(
	state: tauri::State<'_, BridgeState>,
	workspace_id: String,
) -> Result<(), String> {
	let home = dirs::home_dir().ok_or("HOME not set")?;
	let ws_dir = PathBuf::from(&home)
		.join(".zharness")
		.join("agent")
		.join("workspaces")
		.join(&workspace_id);

	if !ws_dir.exists() {
		return Err(format!("Workspace {} not found", workspace_id));
	}

	// Read the cwd from meta.json before deleting, so we can kill the sidecar.
	let meta_path = ws_dir.join("meta.json");
	let cwd: Option<String> = if meta_path.exists() {
		if let Ok(raw) = std::fs::read_to_string(&meta_path) {
			if let Ok(meta) = serde_json::from_str::<Value>(&raw) {
				meta.get("cwd")
					.and_then(|v| v.as_str())
					.map(|s| s.to_string())
			} else {
				None
			}
		} else {
			None
		}
	} else {
		None
	};

	// Kill sidecar if running.
	if let Some(ref cwd) = cwd {
		kill_sidecar_for_cwd(state.inner(), cwd);
	}

	// Remove the workspace directory.
	std::fs::remove_dir_all(&ws_dir).map_err(|e| format!("Failed to delete workspace: {e}"))?;

	log_file(&format!("delete_workspace: deleted {}", workspace_id));
	Ok(())
}

/// Reveal a workspace's cwd in the system file manager (Finder on macOS).
#[tauri::command]
pub async fn reveal_workspace(cwd: String) -> Result<(), String> {
	let path = if cwd.starts_with("~") {
		if let Some(home) = dirs::home_dir() {
			format!("{}{}", home.to_string_lossy(), &cwd[1..])
		} else {
			cwd.clone()
		}
	} else {
		cwd.clone()
	};

	if !std::path::Path::new(&path).exists() {
		return Err(format!("Path does not exist: {}", path));
	}

	#[cfg(target_os = "macos")]
	let opener = "open";
	#[cfg(target_os = "linux")]
	let opener = "xdg-open";
	#[cfg(target_os = "windows")]
	let opener = "explorer";

	std::process::Command::new(opener)
		.arg(&path)
		.spawn()
		.map_err(|e| format!("Failed to open file manager: {e}"))?;

	Ok(())
}

/// Provider info returned to the frontend.
#[derive(serde::Serialize)]
pub struct ProviderInfo {
	id: String,
	/// Human-readable display name (from pi-ai built-ins); falls back to id.
	#[serde(rename = "name")]
	name: String,
	has_api_key: bool,
	auth_type: Option<String>, // "api_key" | "oauth"
}

/// Load built-in provider {id -> display name} map from the generated
/// `providers.json` (sourced from pi-ai at build time). Returns an empty map
/// on any failure — callers fall back to the raw id as the display name.
///
/// Search order mirrors `resolve_zharness_command`:
///   1. Packaged: `<resource_dir>/providers.json`
///   2. Dev:      `<CARGO_MANIFEST_DIR>/../../dist/providers.json`
fn load_builtin_providers(app: &AppHandle) -> HashMap<String, String> {
	let candidates: Vec<PathBuf> = {
		let mut v = Vec::new();
		if let Ok(resource_dir) = app.path().resource_dir() {
			v.push(resource_dir.join("providers.json"));
		}
		v.push(
			PathBuf::from(env!("CARGO_MANIFEST_DIR"))
				.join("..")
				.join("..")
				.join("dist")
				.join("providers.json"),
		);
		v
	};

	for path in candidates {
		match std::fs::read_to_string(&path) {
			Ok(raw) => match serde_json::from_str::<HashMap<String, String>>(&raw) {
				Ok(parsed) => return parsed,
				Err(e) => log_file(&format!(
					"load_builtin_providers: {} exists but failed to parse JSON: {}",
					path.display(),
					e
				)),
			},
			Err(_) => {} // file missing — try next candidate
		}
	}
	log_file("load_builtin_providers: no readable providers.json found in any candidate path");
	HashMap::new()
}

/// List all known providers and their auth status from auth.json.
/// The built-in provider list and display names come from the generated
/// `providers.json` (pi-ai catalog). Providers present in auth.json but not
/// in the catalog (custom providers) are appended with their raw id as name.
#[tauri::command]
pub async fn list_providers(app: AppHandle) -> Result<Vec<ProviderInfo>, String> {
	let home = dirs::home_dir().ok_or("HOME not set")?;
	let auth_path = PathBuf::from(&home)
		.join(".zharness")
		.join("agent")
		.join("auth.json");
	let models_path = PathBuf::from(&home)
		.join(".zharness")
		.join("agent")
		.join("models.json");

	let mut auth_data: serde_json::Map<String, Value> = serde_json::Map::new();
	if auth_path.exists() {
		if let Ok(raw) = std::fs::read_to_string(&auth_path) {
			if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
				if let Some(obj) = parsed.as_object() {
					auth_data = obj.clone();
				}
			}
		}
	}

	// Custom providers live in models.json (see `add_custom_provider`). Read it
	// so the GUI list reflects them with `has_api_key: true` when configured.
	let mut models_providers: serde_json::Map<String, Value> = serde_json::Map::new();
	if models_path.exists() {
		if let Ok(raw) = std::fs::read_to_string(&models_path) {
			if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
				if let Some(obj) = parsed.get("providers").and_then(|v| v.as_object()) {
					models_providers = obj.clone();
				}
			}
		}
	}

	// Built-in providers: { id -> display name } from pi-ai (generated JSON).
	// Preserve catalog order by reading the file as an ordered map.
	let builtin_names: HashMap<String, String> = load_builtin_providers(&app);
	// Preserve stable display order: sorted by id.
	let mut builtin_ids: Vec<&String> = builtin_names.keys().collect();
	builtin_ids.sort();

	let mut providers: Vec<ProviderInfo> = Vec::new();
	let mut seen: HashSet<String> = HashSet::new();

	for id in &builtin_ids {
		seen.insert((*id).clone());
		let cred = auth_data.get(*id);
		let has_api_key = cred.is_some();
		let auth_type = cred
			.and_then(|c| c.get("type"))
			.and_then(|t| t.as_str())
			.map(|s| s.to_string());
		providers.push(ProviderInfo {
			id: (*id).clone(),
			name: builtin_names
				.get(*id)
				.cloned()
				.unwrap_or_else(|| (*id).clone()),
			has_api_key,
			auth_type,
		});
	}

	// Custom providers from auth.json (not in the built-in catalog).
	for (key, _val) in &auth_data {
		if !seen.contains(key) {
			let cred = auth_data.get(key);
			let auth_type = cred
				.and_then(|c| c.get("type"))
				.and_then(|t| t.as_str())
				.map(|s| s.to_string());
			providers.push(ProviderInfo {
				id: key.clone(),
				name: key.clone(),
				has_api_key: true,
				auth_type,
			});
			seen.insert(key.clone());
		}
	}

	// Custom providers from models.json. These may or may not have an apiKey
	// (some setups pull keys from env vars); surface them whenever the entry
	// exists so the user can edit/remove via the GUI.
	for (key, entry) in &models_providers {
		if !seen.contains(key) {
			let has_api_key = entry.get("apiKey").and_then(|v| v.as_str()).is_some();
			providers.push(ProviderInfo {
				id: key.clone(),
				name: key.clone(),
				has_api_key,
				auth_type: if has_api_key {
					Some("api_key".into())
				} else {
					None
				},
			});
			seen.insert(key.clone());
		}
	}

	Ok(providers)
}

/// Set an API key for a provider in auth.json.
#[tauri::command]
pub async fn set_provider_api_key(
	state: tauri::State<'_, BridgeState>,
	provider: String,
	api_key: String,
) -> Result<(), String> {
	let home = dirs::home_dir().ok_or("HOME not set")?;
	let auth_dir = PathBuf::from(&home).join(".zharness").join("agent");
	let auth_path = auth_dir.join("auth.json");

	// Ensure directory exists
	if !auth_dir.exists() {
		std::fs::create_dir_all(&auth_dir).map_err(|e| format!("create_dir: {e}"))?;
	}

	// Read existing auth.json
	let mut auth_data: serde_json::Map<String, Value> = serde_json::Map::new();
	if auth_path.exists() {
		if let Ok(raw) = std::fs::read_to_string(&auth_path) {
			if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
				if let Some(obj) = parsed.as_object() {
					auth_data = obj.clone();
				}
			}
		}
	}

	// Set the API key
	auth_data.insert(
		provider.clone(),
		serde_json::json!({ "type": "api_key", "key": api_key }),
	);

	// Write back
	let json = serde_json::to_string_pretty(&Value::Object(auth_data))
		.map_err(|e| format!("serialize: {e}"))?;
	std::fs::write(&auth_path, &json).map_err(|e| format!("write: {e}"))?;

	// Set file permissions to 600
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		let _ = std::fs::set_permissions(&auth_path, std::fs::Permissions::from_mode(0o600));
	}

	log_file(&format!("set_provider_api_key: set key for {}", provider));
	// auth.json is shared across all workspaces: tell every running sidecar
	// to reload its in-memory credentials so a model switch uses this new key.
	broadcast_to_all_sidecars(&state, "reload_providers");
	Ok(())
}

/// Remove a provider's credentials from auth.json.
#[tauri::command]
pub async fn remove_provider_api_key(
	state: tauri::State<'_, BridgeState>,
	provider: String,
) -> Result<(), String> {
	let home = dirs::home_dir().ok_or("HOME not set")?;
	let auth_path = PathBuf::from(&home)
		.join(".zharness")
		.join("agent")
		.join("auth.json");

	if !auth_path.exists() {
		return Ok(()); // Nothing to remove
	}

	let raw = std::fs::read_to_string(&auth_path).map_err(|e| format!("read: {e}"))?;
	let mut parsed: Value = serde_json::from_str(&raw).map_err(|e| format!("parse: {e}"))?;

	if let Some(obj) = parsed.as_object_mut() {
		obj.remove(&provider);
	}

	let json = serde_json::to_string_pretty(&parsed).map_err(|e| format!("serialize: {e}"))?;
	std::fs::write(&auth_path, &json).map_err(|e| format!("write: {e}"))?;

	log_file(&format!(
		"remove_provider_api_key: removed key for {}",
		provider
	));
	// Notify every sidecar so they drop the now-removed credential from
	// their in-memory cache (otherwise auth still resolves as configured).
	broadcast_to_all_sidecars(&state, "reload_providers");
	Ok(())
}

// =============================================================================
// Custom OpenAI-compatible provider
// =============================================================================
//
// These commands add/remove entries in `~/.zharness/agent/models.json` (the file
// `ModelRegistry.loadCustomModels` reads). They are the GUI counterpart to the
// TUI's `/add-provider` slash command — both paths write the same shape so a
// provider added in one UI shows up in the other on the next model picker open
// (after a `reload_providers` broadcast).

fn models_json_path() -> Result<PathBuf, String> {
	let home = dirs::home_dir().ok_or("HOME not set")?;
	Ok(PathBuf::from(&home)
		.join(".zharness")
		.join("agent")
		.join("models.json"))
}

fn is_valid_provider_name(name: &str) -> bool {
	!name.is_empty()
		&& name
			.chars()
			.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Add a custom OpenAI-compatible provider to `~/.zharness/agent/models.json`.
///
/// The Rust side owns the file write (the webview is sandboxed and cannot reach
/// the agent dir). After writing, broadcasts `reload_providers` so every running
/// sidecar re-reads `models.json` and the new models show up in the picker.
#[tauri::command]
pub async fn add_custom_provider(
	state: tauri::State<'_, BridgeState>,
	name: String,
	base_url: String,
	api_key: Option<String>,
	model_ids: Vec<String>,
	context_window: Option<i64>,
	api: Option<String>,
) -> Result<(), String> {
	if !is_valid_provider_name(&name) {
		return Err(format!(
			"Invalid provider name {:?}: must be non-empty and contain only letters, digits, '-' or '_'",
			name
		));
	}
	if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
		return Err(format!(
			"Invalid baseUrl {:?}: must start with http:// or https://",
			base_url
		));
	}
	if model_ids.is_empty() {
		return Err("At least one model id is required".into());
	}
	for id in &model_ids {
		if id.trim().is_empty() {
			return Err("Model id must not be empty".into());
		}
	}
	// Wire protocol — whitelist keeps the file aligned with the pi-ai `Api`
	// implementations the runtime can actually stream. Defaults to the
	// OpenAI-compatible protocol for backward compatibility with older GUIs.
	const CUSTOM_PROVIDER_APIS: [&str; 3] = [
		"openai-completions",
		"anthropic-messages",
		"openai-responses",
	];
	let api = api.unwrap_or_else(|| "openai-completions".to_string());
	if !CUSTOM_PROVIDER_APIS.contains(&api.as_str()) {
		return Err(format!(
			"Invalid api {:?}: must be one of {}",
			api,
			CUSTOM_PROVIDER_APIS.join(", ")
		));
	}
	// The context window recorded here drives the compaction threshold (see
	// src/core/compaction/compaction-engine.ts), so a wrong value either
	// compacts too early or lets the session hit the provider's real limit.
	let context_window = context_window.unwrap_or(128_000);
	if context_window <= 0 {
		return Err("Invalid contextWindow: must be a positive number of tokens".into());
	}

	let path = models_json_path()?;
	if let Some(parent) = path.parent() {
		if !parent.exists() {
			std::fs::create_dir_all(parent).map_err(|e| format!("create_dir: {e}"))?;
		}
	}

	// Read existing or start with an empty object.
	let mut config: Value = if path.exists() {
		let raw = std::fs::read_to_string(&path).map_err(|e| format!("read: {e}"))?;
		serde_json::from_str(&raw).map_err(|e| format!("parse existing models.json: {e}"))?
	} else {
		serde_json::json!({})
	};

	if !config.is_object() {
		return Err("models.json root must be an object".into());
	}
	if !config
		.get("providers")
		.map(|v| v.is_object())
		.unwrap_or(false)
	{
		config["providers"] = serde_json::json!({});
	}

	// Build the new provider entry — shape matches the TypeScript
	// `ProviderConfigSchema` in `src/core/model-registry.ts:196`.
	let trimmed_url = base_url.trim_end_matches('/').to_string();
	let models_json: Vec<Value> = model_ids
		.iter()
		.map(|id| {
			serde_json::json!({
				"id": id,
				"name": id,
				"contextWindow": context_window,
				"maxTokens": 16_384,
			})
		})
		.collect();

	let mut provider = serde_json::json!({
		"baseUrl": trimmed_url,
		"api": api,
		"models": models_json,
	});
	if let Some(key) = api_key {
		if !key.is_empty() {
			provider["apiKey"] = Value::String(key);
		}
	}

	config["providers"][&name] = provider;

	let json = serde_json::to_string_pretty(&config).map_err(|e| format!("serialize: {e}"))?;
	std::fs::write(&path, json).map_err(|e| format!("write: {e}"))?;

	log_file(&format!(
		"add_custom_provider: wrote provider {} -> {}",
		name, trimmed_url
	));
	broadcast_to_all_sidecars(&state, "reload_providers");
	Ok(())
}

/// Remove a custom provider from `~/.zharness/agent/models.json`. No-op if the
/// file or the entry is missing. Broadcasts `reload_providers` so the change
/// shows up in the model picker.
#[tauri::command]
pub async fn remove_custom_provider(
	state: tauri::State<'_, BridgeState>,
	name: String,
) -> Result<(), String> {
	if !is_valid_provider_name(&name) {
		return Err(format!("Invalid provider name {:?}", name));
	}

	let path = models_json_path()?;
	if !path.exists() {
		return Ok(());
	}

	let raw = std::fs::read_to_string(&path).map_err(|e| format!("read: {e}"))?;
	let mut parsed: Value = serde_json::from_str(&raw).map_err(|e| format!("parse: {e}"))?;

	if let Some(providers) = parsed.get_mut("providers").and_then(|v| v.as_object_mut()) {
		if providers.remove(&name).is_some() {
			let json =
				serde_json::to_string_pretty(&parsed).map_err(|e| format!("serialize: {e}"))?;
			std::fs::write(&path, json).map_err(|e| format!("write: {e}"))?;
			log_file(&format!("remove_custom_provider: removed {}", name));
			broadcast_to_all_sidecars(&state, "reload_providers");
		}
	}
	Ok(())
}

/// Fetch `{baseUrl}/models` and return the id list. Used by the
/// "Custom / OpenAI-Compatible" provider form in the GUI.
///
/// The webview cannot do this directly (CORS), so the call goes through Rust.
/// Returns an empty list on any error so the UI falls back to a manual model
/// id input — same contract as the TS `fetchOpenAIModels` helper.
#[tauri::command]
pub async fn fetch_openai_models(
	base_url: String,
	api_key: Option<String>,
) -> Result<Vec<ModelIdInfo>, String> {
	let trimmed = base_url.trim_end_matches('/');
	let url = format!("{}/models", trimmed);

	let client = reqwest::Client::builder()
		.timeout(Duration::from_secs(10))
		.build()
		.map_err(|e| format!("HTTP client error: {e}"))?;

	let mut req = client.get(&url).header("Accept", "application/json");
	if let Some(key) = api_key {
		if !key.is_empty() {
			req = req.bearer_auth(key);
		}
	}

	let resp = match req.send().await {
		Ok(r) => r,
		Err(_) => return Ok(Vec::new()),
	};
	if !resp.status().is_success() {
		return Ok(Vec::new());
	}
	let body: Value = match resp.json().await {
		Ok(v) => v,
		Err(_) => return Ok(Vec::new()),
	};
	let Some(data) = body.get("data").and_then(|v| v.as_array()) else {
		return Ok(Vec::new());
	};
	let ids: Vec<ModelIdInfo> = data
		.iter()
		.filter_map(|m| {
			m.get("id")
				.and_then(|id| id.as_str())
				.map(|s| ModelIdInfo { id: s.to_string() })
		})
		.collect();
	Ok(ids)
}

#[derive(serde::Serialize)]
pub struct ModelIdInfo {
	pub id: String,
}

/// Set the window background color (for theme adaptation).
#[tauri::command]
pub async fn set_window_background(app: AppHandle, r: u8, g: u8, b: u8) -> Result<(), String> {
	let window = app
		.get_webview_window("main")
		.or_else(|| app.webview_windows().into_iter().next().map(|(_, w)| w));
	if let Some(window) = window {
		window
			.set_background_color(Some(tauri::webview::Color(r, g, b, 255)))
			.map_err(|e| format!("set_background_color: {e}"))?;
	}
	Ok(())
}

/// Transcribe audio data using OpenAI's Whisper API.
///
/// `audio_b64` is base64-encoded audio data (no data-URL prefix).
/// `mime_type` is the audio MIME type (e.g. "audio/webm", "audio/mp4").
/// The OpenAI API key is read from ~/.zharness/agent/auth.json under the "openai" key.
#[tauri::command]
pub async fn transcribe_audio(audio_b64: String, mime_type: String) -> Result<String, String> {
	let api_key = read_api_key("openai").ok_or_else(|| {
		"OpenAI API key not found. Add it in Settings to use voice input.".to_string()
	})?;

	// Decode base64 audio.
	let audio_bytes =
		base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &audio_b64)
			.map_err(|e| format!("base64 decode: {e}"))?;

	// Determine file extension from MIME type.
	let ext = match mime_type.as_str() {
		"audio/webm" => "webm",
		"audio/mp4" | "audio/m4a" => "mp4",
		"audio/ogg" => "ogg",
		"audio/wav" | "audio/wave" | "audio/x-wav" => "wav",
		"audio/mpeg" | "audio/mp3" => "mp3",
		_ => "webm",
	};
	let filename = format!("recording.{}", ext);

	// Build multipart form and POST to OpenAI Whisper API.
	let part = reqwest::multipart::Part::bytes(audio_bytes)
		.file_name(filename)
		.mime_str(&mime_type)
		.map_err(|e| format!("mime_str: {e}"))?;
	let form = reqwest::multipart::Form::new()
		.text("model", "whisper-1")
		.part("file", part);

	let client = reqwest::Client::new();
	let resp = client
		.post("https://api.openai.com/v1/audio/transcriptions")
		.bearer_auth(&api_key)
		.multipart(form)
		.send()
		.await
		.map_err(|e| format!("Whisper request: {e}"))?;

	if !resp.status().is_success() {
		let status = resp.status();
		let body = resp.text().await.unwrap_or_default();
		let msg = if body.len() > 500 {
			format!("Whisper API error ({}): {}...", status, &body[..500])
		} else {
			format!("Whisper API error ({}): {}", status, body)
		};
		log_file(&msg);
		return Err(msg);
	}

	let json: Value = resp
		.json()
		.await
		.map_err(|e| format!("Whisper response parse: {e}"))?;

	let text = json
		.get("text")
		.and_then(|t| t.as_str())
		.unwrap_or("")
		.trim()
		.to_string();

	Ok(text)
}

/// Check if a command exists in PATH.
/// Uses `/usr/bin/which` on macOS (since `which` is a shell built-in)
/// and `which` on other platforms.
fn which(cmd: &str) -> bool {
	#[cfg(target_os = "macos")]
	let which_bin = "/usr/bin/which";
	#[cfg(not(target_os = "macos"))]
	let which_bin = "which";

	std::process::Command::new(which_bin)
		.arg(cmd)
		.stdout(std::process::Stdio::null())
		.stderr(std::process::Stdio::null())
		.status()
		.map(|s| s.success())
		.unwrap_or(false)
}

/// Open a file in the user's preferred IDE/editor.
/// Tries common CLI editors (code, cursor, windsurf, zed, etc.) in order,
/// falls back to the system default (`open` on macOS, `xdg-open` on Linux,
/// `start` on Windows).
#[tauri::command]
pub async fn open_in_editor(cwd: String, file_path: String) -> Result<(), String> {
	let full = resolve_workspace_path(&cwd, Some(&file_path))?;
	if !full.exists() {
		return Err(format!("File does not exist: {}", full.display()));
	}

	let path_str = full.to_string_lossy().to_string();

	// On macOS, try `open -a <App>` for known GUI editors.
	// We use `status()` (not `spawn()`) to detect if the app actually exists.
	#[cfg(target_os = "macos")]
	{
		let apps: &[&str] = &[
			"Cursor",
			"Windsurf",
			"Visual Studio Code",
			"Zed",
			"Sublime Text",
		];
		for app in apps {
			let result = std::process::Command::new("open")
				.arg("-a")
				.arg(app)
				.arg(&path_str)
				.status();
			if let Ok(status) = result {
				if status.success() {
					log::info!("open_in_editor: launched via open -a {} {}", app, path_str);
					return Ok(());
				}
			}
		}
	}

	// Try common CLI editor launchers in priority order.
	let editors: &[&str] = &["cursor", "windsurf", "code", "zed", "subl"];
	for editor in editors {
		if which(editor) {
			log::info!("open_in_editor: launching {} {}", editor, path_str);
			std::process::Command::new(editor)
				.arg(&path_str)
				.spawn()
				.map_err(|e| format!("Failed to launch {editor}: {e}"))?;
			return Ok(());
		}
	}

	// Fallback: use the system default application handler.
	#[cfg(target_os = "macos")]
	let (opener, args) = ("open", vec![path_str]);
	#[cfg(target_os = "linux")]
	let (opener, args) = ("xdg-open", vec![path_str]);
	#[cfg(target_os = "windows")]
	let (opener, args) = (
		"cmd",
		vec![
			"/C".to_string(),
			"start".to_string(),
			"".to_string(),
			path_str,
		],
	);

	std::process::Command::new(opener)
		.args(&args)
		.status()
		.map_err(|e| format!("Failed to open file: {e}"))?;

	Ok(())
}

/// Reveal a file or directory in the system file manager (Finder on macOS,
/// Explorer on Windows, etc.). When `sub_path` points to a file, the file's
/// containing directory is opened with the file selected (macOS uses
/// `open -R`); when it points to a directory, the directory itself is
/// opened.
#[tauri::command]
pub async fn reveal_path(cwd: String, sub_path: String) -> Result<(), String> {
	let full = resolve_workspace_path(&cwd, Some(&sub_path))?;
	if !full.exists() {
		return Err(format!("Path does not exist: {}", full.display()));
	}

	let path_str = full.to_string_lossy().to_string();

	#[cfg(target_os = "macos")]
	{
		// `open -R <file>` reveals the file in Finder (selected). For a
		// directory, fall back to `open <dir>` since `-R` requires an
		// existing file.
		if full.is_file() {
			std::process::Command::new("open")
				.arg("-R")
				.arg(&path_str)
				.spawn()
				.map_err(|e| format!("Failed to reveal file: {e}"))?;
			return Ok(());
		}
	}

	#[cfg(target_os = "macos")]
	let opener = "open";
	#[cfg(target_os = "linux")]
	let opener = "xdg-open";
	#[cfg(target_os = "windows")]
	let opener = "explorer";

	std::process::Command::new(opener)
		.arg(&path_str)
		.spawn()
		.map_err(|e| format!("Failed to open file manager: {e}"))?;

	Ok(())
}

// --- File explorer (list_dir / read_file) ---

/// Directories to skip when listing (to avoid huge / irrelevant trees).
const SKIP_DIRS: &[&str] = &[
	".git",
	"node_modules",
	"target",
	".next",
	".cache",
	".turbo",
	"dist",
	"build",
	".DS_Store",
];

#[derive(serde::Serialize)]
pub struct DirEntry {
	pub name: String,
	pub path: String,
	pub is_dir: bool,
	pub size: u64,
}

/// Resolve `cwd` (expanding `~`) and join `sub_path` if provided.
fn resolve_workspace_path(cwd: &str, sub_path: Option<&str>) -> Result<PathBuf, String> {
	let expanded = if cwd.starts_with("~") {
		let home = dirs::home_dir().ok_or("HOME not set")?;
		format!("{}{}", home.to_string_lossy(), &cwd[1..])
	} else {
		cwd.to_string()
	};
	let base = PathBuf::from(&expanded);
	let full = match sub_path {
		Some(s) if !s.is_empty() => base.join(s),
		_ => base,
	};
	// Canonicalize to resolve any `..` etc., but fall back to the raw path.
	Ok(full.canonicalize().unwrap_or(full))
}

/// List entries in a directory within the workspace. `sub_path` is relative
/// to `cwd`. Directories in `SKIP_DIRS` are excluded.
#[tauri::command]
pub async fn list_dir(cwd: String, sub_path: Option<String>) -> Result<Vec<DirEntry>, String> {
	let dir = resolve_workspace_path(&cwd, sub_path.as_deref())?;
	if !dir.exists() {
		return Err(format!("Directory does not exist: {}", dir.display()));
	}
	if !dir.is_dir() {
		return Err(format!("Not a directory: {}", dir.display()));
	}

	let base = resolve_workspace_path(&cwd, None)?;
	let entries = std::fs::read_dir(&dir).map_err(|e| format!("read_dir: {e}"))?;

	let mut result: Vec<DirEntry> = Vec::new();
	for entry in entries.filter_map(|e| e.ok()) {
		let file_name = entry.file_name().to_string_lossy().to_string();
		// Skip known huge / irrelevant directories.
		if SKIP_DIRS.contains(&file_name.as_str()) {
			continue;
		}
		let file_type = entry.file_type().map_err(|e| format!("file_type: {e}"))?;
		let full_path = entry.path();
		// Compute relative path from workspace root.
		let rel = full_path
			.strip_prefix(&base)
			.map(|p| p.to_string_lossy().to_string())
			.unwrap_or_else(|_| file_name.clone());
		let size = if file_type.is_dir() {
			0
		} else {
			entry.metadata().map(|m| m.len()).unwrap_or(0)
		};
		result.push(DirEntry {
			name: file_name,
			path: rel,
			is_dir: file_type.is_dir(),
			size,
		});
	}

	// Sort: directories first, then alphabetical.
	result.sort_by(|a, b| {
		b.is_dir
			.cmp(&a.is_dir)
			.then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
	});

	Ok(result)
}

/// Read a file's text content within the workspace. `file_path` is relative
/// to `cwd`. Files larger than 2 MB are rejected to avoid UI overload.
#[tauri::command]
pub async fn read_file(cwd: String, file_path: String) -> Result<String, String> {
	let full = resolve_workspace_path(&cwd, Some(&file_path))?;
	if !full.exists() {
		return Err(format!("File does not exist: {}", full.display()));
	}
	if full.is_dir() {
		return Err(format!("Path is a directory: {}", full.display()));
	}
	let metadata = std::fs::metadata(&full).map_err(|e| format!("metadata: {e}"))?;
	const MAX_SIZE: u64 = 2 * 1024 * 1024; // 2 MB
	if metadata.len() > MAX_SIZE {
		return Err(format!(
			"File is too large ({} bytes, max {} bytes)",
			metadata.len(),
			MAX_SIZE
		));
	}
	std::fs::read_to_string(&full).map_err(|e| format!("read_to_string: {e}"))
}

/// Fetch the skills.sh leaderboard HTML page via Rust (bypasses CORS).
/// Returns the raw HTML so the frontend can parse skill links.
#[tauri::command]
pub async fn fetch_skills_sh() -> Result<String, String> {
	let client = reqwest::Client::builder()
		.user_agent("zharness-desktop/0.1")
		.timeout(Duration::from_secs(15))
		.build()
		.map_err(|e| format!("HTTP client error: {e}"))?;

	let res = client
		.get("https://www.skills.sh/")
		.send()
		.await
		.map_err(|e| format!("Fetch error: {e}"))?;

	if !res.status().is_success() {
		return Err(format!("skills.sh returned status {}", res.status()));
	}

	let html = res
		.text()
		.await
		.map_err(|e| format!("Read body error: {e}"))?;

	Ok(html)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn resolve_shell_path_never_empty() {
		// Always returns something (login-shell PATH or a fallback to env PATH).
		let path = resolve_shell_path();
		assert!(
			!path.is_empty(),
			"resolve_shell_path must return a non-empty PATH"
		);
	}

	#[test]
	fn run_shell_capture_path_is_clean() {
		// When captured, the PATH must be a single line with no surrounding
		// whitespace (the printf %s form guarantees no trailing newline).
		if let Some(path) = run_shell_capture_path("/bin/zsh") {
			assert!(
				!path.contains('\n'),
				"captured PATH must not contain newlines: {path:?}"
			);
			assert_eq!(path, path.trim(), "captured PATH must be trimmed: {path:?}");
		}
	}

	#[test]
	fn path_equals_tolerates_separators_and_case() {
		// The persistent Chat cwd arrives in mixed spellings; the strict
		// compare used to drop the --main flag for some of them.
		assert!(path_equals(
			"C:\\Users\\tom\\.zharness\\main",
			"C:/Users/tom/.zharness/main"
		));
		assert!(path_equals(
			"C:\\Users/tom/.zharness/main",
			"c:/users/TOM/.zharness/main"
		));
		assert!(!path_equals(
			"C:\\Users\\tom\\.zharness\\main",
			"D:\\work"
		));
	}

	#[test]
	fn normalize_cwd_unifies_separator_spellings() {
		// Same directory must normalize to the same key regardless of the
		// caller's separator choice (webview ~ expansion vs meta.json).
		let backslash = normalize_cwd("C:\\Users\\tom\\.zharness\\main".to_string());
		let mixed = normalize_cwd("C:\\Users/tom/.zharness/main".to_string());
		let forward = normalize_cwd("C:/Users/tom/.zharness/main".to_string());
		assert_eq!(backslash, mixed, "mixed separators must collapse");
		assert_eq!(backslash, forward, "forward slashes must collapse");
		if cfg!(windows) {
			assert!(backslash.contains('\\') && !backslash.contains('/'));
			// Windows normalizes every path (even unix-shaped ones) to
			// backslash-native form.
			assert_eq!(
				normalize_cwd("/home/tom/project".to_string()),
				"\\home\\tom\\project"
			);
		} else {
			// Unix paths are untouched (no drive letter, no backslashes).
			assert_eq!(
				normalize_cwd("/home/tom/project".to_string()),
				"/home/tom/project"
			);
		}
	}

	#[test]
	fn normalize_cwd_expands_tilde_consistently() {
		if let Some(home) = dirs::home_dir() {
			let h = home.to_string_lossy().to_string();
			let expanded = normalize_cwd("~/.zharness/main".to_string());
			let direct = normalize_cwd(format!("{}/.zharness/main", h));
			// Whatever the platform, the ~ form and the pre-expanded form
			// must land on the identical key.
			assert_eq!(expanded, direct, "~ expansion must be idempotent");
		}
	}
}
