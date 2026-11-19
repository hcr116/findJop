/**
 * 统一的路径与配置解析。
 * 原则：所有可变数据（数据库、浏览器 profile、日志）都放在用户数据目录，
 * 不放在程序目录 —— 这样替换/升级程序不会丢数据，也天然做到"各机器各自一份"。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 数据目录优先级：
 *   1. BOSS_JOBS_HOME 环境变量（测试/多档案用）
 *   2. Windows: %APPDATA%\boss-jobs ；macOS/Linux: ~/.config/boss-jobs
 */
export function home() {
  if (process.env.BOSS_JOBS_HOME) return path.resolve(process.env.BOSS_JOBS_HOME);
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'boss-jobs');
  }
  return path.join(os.homedir(), '.config', 'boss-jobs');
}

export function ensureDirs() {
  const h = home();
  const dirs = {
    home: h,
    runs: path.join(h, 'runs'),
    profile: path.join(h, 'browser-profile'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  return dirs;
}

export const dbPath = () => path.join(home(), 'data.db');
export const configPath = () => path.join(home(), 'config.json');

/** 每次运行一个独立目录，失败也留全部证据 */
export function newRunDir(tag = '') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(home(), 'runs', tag ? `${stamp}-${tag}` : stamp);
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  return dir;
}
