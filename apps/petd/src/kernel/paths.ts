/**
 * 路径解析：petd 的所有落盘位置集中在这里（禁止散落 path.join）。
 *
 * 默认 home：%APPDATA%/dayu-pet/petd（与旧桌宠 userData 同级、互不覆盖）；
 * 可用 PETD_HOME 覆盖（测试/多实例用）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PetdPaths {
  home: string;
  configFile: string;
  gatewayFile: string;
  tokenFile: string;
  logFile: string;
  stateDir: string;
  runDir: string;
}

export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.APPDATA && env.APPDATA.trim() ? env.APPDATA : path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'dayu-pet', 'petd');
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): PetdPaths {
  const home = env.PETD_HOME && env.PETD_HOME.trim() ? path.resolve(env.PETD_HOME) : defaultHome(env);
  return {
    home,
    configFile: path.join(home, 'config.json'),
    gatewayFile: path.join(home, 'gateway.json'),
    tokenFile: path.join(home, 'token.json'),
    logFile: path.join(home, 'petd.log'),
    stateDir: path.join(home, 'state'),
    runDir: path.join(home, 'run'),
  };
}

export function ensurePaths(p: PetdPaths): void {
  fs.mkdirSync(p.home, { recursive: true });
  fs.mkdirSync(p.stateDir, { recursive: true });
  fs.mkdirSync(p.runDir, { recursive: true });
}
