import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const env = { ...process.env };
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function prependPath(candidate) {
  if (!candidate || !fs.existsSync(candidate)) {
    return false;
  }

  const currentPath = env.PATH ?? "";
  const entries = currentPath.split(path.delimiter).filter(Boolean);

  if (entries.some((entry) => entry.toLowerCase() === candidate.toLowerCase())) {
    return true;
  }

  env.PATH = [candidate, ...entries].join(path.delimiter);
  return true;
}

function ensureCargoOnPath() {
  const homeDir = os.homedir();
  const cargoBin = path.join(homeDir, ".cargo", "bin");

  prependPath(cargoBin);

  if (process.platform === "win32") {
    const windowsFallbacks = [
      path.join(env.USERPROFILE ?? homeDir, ".cargo", "bin"),
      "C:/Users/Vantiboolean/.cargo/bin",
    ];

    for (const candidate of windowsFallbacks) {
      prependPath(candidate);
    }
  }

  const cargoBinary = process.platform === "win32" ? "cargo.exe" : "cargo";
  const pathEntries = (env.PATH ?? "").split(path.delimiter).filter(Boolean);

  return pathEntries.some((entry) => fs.existsSync(path.join(entry, cargoBinary)));
}

function ensureNodeToolingOnPath() {
  const homeDir = os.homedir();
  const candidates = [
    path.dirname(process.execPath),
    path.join(repoRoot, "node_modules", ".bin"),
    path.join(process.cwd(), "node_modules", ".bin"),
    path.join(homeDir, "AppData", "Roaming", "npm"),
  ];

  for (const candidate of candidates) {
    prependPath(candidate);
  }
}

ensureNodeToolingOnPath();

if (!ensureCargoOnPath()) {
  console.error("Rust/Cargo 未找到。请先安装 Rust，或把 cargo 加入 PATH 后再运行 Tauri。");
  console.error("常见路径: %USERPROFILE%/.cargo/bin");
  process.exit(1);
}

const tauriCliEntry = path.join(repoRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");

if (!fs.existsSync(tauriCliEntry)) {
  console.error(`未找到本地 Tauri CLI: ${tauriCliEntry}`);
  console.error("请先在仓库根目录执行 pnpm install。");
  process.exit(1);
}

const child = spawn(process.execPath, [tauriCliEntry, ...args], {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error("启动 Tauri 失败:", error.message);
  process.exit(1);
});
