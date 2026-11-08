import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executable = path.join(root, 'src-tauri', 'target', 'debug', 'mypaste.exe')
assert(existsSync(executable), '请先运行 npm run desktop:build -- --debug --no-bundle')
const dataDir = mkdtempSync(path.join(root, '.native-smoke-'))
const port = 19241, checks = [], waiting = new Map()
let processHandle, socket, sequence = 0, logs = ''
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(read, timeout = 30000) {
  const deadline = Date.now() + timeout
  let lastError
  while(Date.now() < deadline) {
    try { const value = await read(); if(value) return value } catch(error) { lastError = error }
    await pause(200)
  }
  throw lastError ?? new Error('等待桌面窗口超时')
}
function rpc(method, params = {}) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { waiting.delete(id); reject(new Error(`CDP ${method} 超时`)) }, 10000)
    waiting.set(id, { resolve, reject, timeout }); socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if(result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}
const command = (name, args = {}) => evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)}, ${JSON.stringify(args)})`)
function check(name, condition) { assert(condition, name); checks.push({ name, passed: true }) }
async function start() {
  processHandle = spawn(executable, [], { cwd: root, env: { ...process.env, MYPASTE_DATA_DIR: dataDir, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, RUST_BACKTRACE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  processHandle.stdout.on('data', chunk => { logs += chunk.toString() }); processHandle.stderr.on('data', chunk => { logs += chunk.toString() })
  processHandle.on('error', error => { logs += error.message })
  const target = await until(async () => {
    if(processHandle.exitCode !== null) throw new Error(`桌面进程退出：${logs.slice(-1000)}`)
    const response = await fetch(`http://127.0.0.1:${port}/json/list`)
    return (await response.json()).find(item => item.type === 'page' && item.webSocketDebuggerUrl)
  })
  socket = new WebSocket(target.webSocketDebuggerUrl)
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), pending = waiting.get(message.id)
    if(!pending) return
    clearTimeout(pending.timeout); waiting.delete(message.id)
    if(message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result)
  })
  await once(socket, 'open')
  await until(() => evaluate('typeof window.__TAURI_INTERNALS__?.invoke === "function"'))
  await until(() => evaluate('document.querySelector(".prototype-badge")?.textContent === "本地模式"'))
}
async function stop() {
  socket?.close(); socket = undefined
  if(processHandle && processHandle.exitCode === null) { const exited = once(processHandle, 'exit'); processHandle.kill(); await exited }
  processHandle = undefined; await pause(400)
}
try {
  await start(); check('真实桌面 WebView 使用本地模式', true)
  let snapshot = await command('get_snapshot')
  check('数据目录为本次独立验收目录', path.resolve(snapshot.dataDir).toLowerCase() === dataDir.toLowerCase())
  check('首次启动没有填入演示记录', snapshot.items.length === 0)
  await command('update_settings', { patch: { paused: true, retentionDays: 7, maxItems: 1000, excludedApps: ['SyntheticVault.exe', ' syntheticvault '] } })
  await command('create_collection', { name: '原生验收集合' })
  snapshot = await command('get_snapshot')
  check('设置 IPC 已持久化', snapshot.settings.paused && snapshot.settings.retentionDays === 7 && snapshot.settings.maxItems === 1000)
  check('排除应用去重并保留原始名称', JSON.stringify(snapshot.settings.excludedApps) === JSON.stringify(['SyntheticVault.exe']))
  check('集合 IPC 已持久化', snapshot.collections.includes('原生验收集合'))
  let rejected = false
  try { await command('get_item', { id: -1 }) } catch { rejected = true }
  check('不存在的记录返回错误', rejected)
  rejected = false
  try { await command('update_settings', { patch: { retentionDays: -1 } }) } catch { rejected = true }
  check('非法保留策略被拒绝', rejected)
  rejected = false
  try { await command('update_settings', { patch: { excludedApps: ['bad\nname'] } }) } catch { rejected = true }
  check('非法排除应用名被拒绝', rejected)
  rejected = false
  try { await command('get_thumbnail', { id: 1 }) } catch { rejected = true }
  check('图片缩略图命令拒绝不存在的记录', rejected)
  await stop(); await start(); snapshot = await command('get_snapshot')
  check('重启保留暂停状态', snapshot.settings.paused && snapshot.status.captureState === 'paused')
  check('重启保留集合和设置', snapshot.collections.includes('原生验收集合') && snapshot.settings.retentionDays === 7 && snapshot.settings.maxItems === 1000)
  check('重启保留排除应用', JSON.stringify(snapshot.settings.excludedApps) === JSON.stringify(['SyntheticVault.exe']))
  check('验收期间未写入任何记录', snapshot.items.length === 0)
  await stop()
  writeFileSync(path.join(root, 'docs', 'native-smoke-result.json'), JSON.stringify({ checkedAt: new Date().toISOString(), checks, clipboardReadOrWriteByTest: false, note: '真实桌面IPC与重启验收；不覆盖用户剪贴板，不替代系统采集/粘贴的人工验收。' }, null, 2))
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2))
} catch(error) { console.error(error.message); if(logs) console.error(logs.slice(-1500)); process.exitCode = 1 }
finally { await stop() }
