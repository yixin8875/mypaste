// Isolated native acceptance for P2B: per-collection retention, diagnostics,
// sequence status safety and portable mode. It never reads or writes the real
// clipboard; sequence commands are exercised only on invalid/empty selections
// and idle status, so they fail before any clipboard call.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executable = path.join(root, 'src-tauri', 'target', 'debug', 'mypaste.exe')
assert(existsSync(executable), '请先运行 npm run desktop:build -- --debug --no-bundle')
const work = mkdtempSync(path.join(tmpdir(), 'mypaste-p2b-'))
const dataDir = path.join(work, 'data')
const portableDir = path.join(work, 'portable')
const port = 19242
const checks = []
let processHandle, socket, sequence = 0, logs = ''
const waiting = new Map()
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
async function rejects(name, action) {
  let rejected = false
  try { await action() } catch { rejected = true }
  check(name, rejected)
}
async function start(exe, env, cwd) {
  logs = ''; sequence = 0; waiting.clear()
  processHandle = spawn(exe, [], { cwd, env: { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, RUST_BACKTRACE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  processHandle.stdout.on('data', chunk => { logs += chunk.toString() }); processHandle.stderr.on('data', chunk => { logs += chunk.toString() })
  processHandle.on('error', error => { logs += error.message })
  const target = await until(async () => {
    if(processHandle.exitCode !== null) throw new Error(`桌面进程退出：${logs.slice(-1200)}`)
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
  processHandle = undefined; await pause(500)
}

try {
  await start(executable, { ...process.env, MYPASTE_DATA_DIR: dataDir }, root)
  let snapshot = await command('get_snapshot')
  check('真实桌面 WebView 使用本地模式', true)
  check('普通模式数据目录为本次独立验收目录', path.resolve(snapshot.dataDir).toLowerCase() === path.resolve(dataDir).toLowerCase())
  check('首次启动没有序列或集合策略', snapshot.sequence.active === false && snapshot.collectionPolicies.length === 0)
  check('普通模式 status.portable 为 false', snapshot.status.portable === false)

  await rejects('为不存在的集合设置策略被拒绝', () => command('set_collection_policy', { name: '不存在的集合', retentionDays: 90, maxItems: 1000 }))
  await command('create_collection', { name: '合成策略' })
  await command('set_collection_policy', { name: '合成策略', retentionDays: 90, maxItems: 1000 })
  snapshot = await command('get_snapshot')
  let policy = snapshot.collectionPolicies.find(entry => entry.name === '合成策略')
  check('集合保留时间与条数上限已持久化', policy?.retentionDays === 90 && policy?.maxItems === 1000)
  await rejects('保留天数为 0 被拒绝', () => command('set_collection_policy', { name: '合成策略', retentionDays: 0, maxItems: 1000 }))
  await rejects('保留天数超过上限被拒绝', () => command('set_collection_policy', { name: '合成策略', retentionDays: 4000, maxItems: 1000 }))
  await rejects('条数上限为 0 被拒绝', () => command('set_collection_policy', { name: '合成策略', retentionDays: 90, maxItems: 0 }))
  await command('set_collection_policy', { name: '合成策略', retentionDays: null, maxItems: null })
  snapshot = await command('get_snapshot')
  policy = snapshot.collectionPolicies.find(entry => entry.name === '合成策略')
  check('清空后跟随全局策略', policy?.retentionDays === null && policy?.maxItems === null)

  const logInfo = await command('get_log_info')
  check('日志目录位于数据目录下', path.resolve(logInfo.dir).toLowerCase() === path.join(path.resolve(dataDir), 'logs').toLowerCase())
  check('日志文件名为 mypaste.log', path.basename(logInfo.file) === 'mypaste.log')
  const diagnostics = path.join(work, 'diagnostics.txt')
  await command('export_diagnostics', { path: diagnostics })
  const body = readFileSync(diagnostics, 'utf8')
  check('诊断文件包含版本与日志目录', body.includes('MyPaste diagnostics') && body.includes('logDir:'))
  check('诊断文件正确标记非便携模式', body.includes('portable: false'))
  check('诊断文件不包含集合名或剪贴板正文', !body.includes('合成策略') && !body.includes('synthetic clipboard content'))
  await rejects('诊断导出拒绝覆盖当前数据库', () => command('export_diagnostics', { path: path.join(dataDir, 'history.sqlite3') }))

  check('初始序列状态为空闲', (await command('sequence_status')).active === false)
  check('无序列时推进返回空闲且不写剪贴板', (await command('sequence_next')).active === false)
  await rejects('空选择开始序列被拒绝', () => command('start_sequence', { ids: [] }))
  await rejects('不存在的记录开始序列被拒绝', () => command('start_sequence', { ids: [999999] }))
  check('结束序列返回空闲', (await command('stop_sequence')).active === false)

  await stop()

  // Portable mode: a marker beside the executable wins over storage.json and MYPASTE_DATA_DIR.
  mkdirSync(portableDir, { recursive: true })
  copyFileSync(executable, path.join(portableDir, 'MyPaste.exe'))
  writeFileSync(path.join(portableDir, 'portable.txt'), 'synthetic portable marker\r\n', 'utf8')
  const portableEnv = { ...process.env }
  delete portableEnv.MYPASTE_DATA_DIR
  await start(path.join(portableDir, 'MyPaste.exe'), portableEnv, portableDir)
  snapshot = await command('get_snapshot')
  check('便携模式 status.portable 为 true', snapshot.status.portable === true)
  check('便携模式数据位于 exe 同目录 data 文件夹', path.resolve(snapshot.dataDir).toLowerCase() === path.resolve(portableDir, 'data').toLowerCase())
  check('便携模式创建了 history.sqlite3', existsSync(path.join(portableDir, 'data', 'history.sqlite3')))
  const portableLogs = await command('get_log_info')
  check('便携模式日志位于 data/logs', path.resolve(portableLogs.dir).toLowerCase() === path.resolve(portableDir, 'data', 'logs').toLowerCase())
  await rejects('便携模式拒绝更改存储目录', () => command('set_data_dir', { path: path.join(work, 'elsewhere') }))
  const portableDiagnostics = path.join(work, 'portable-diagnostics.txt')
  await command('export_diagnostics', { path: portableDiagnostics })
  check('便携模式诊断标记 portable: true', readFileSync(portableDiagnostics, 'utf8').includes('portable: true'))
  await stop()

  writeFileSync(path.join(root, 'docs', 'native-p2b-result.json'), JSON.stringify({
    checkedAt: new Date().toISOString(),
    checks,
    clipboardReadOrWriteByTest: false,
    skipped: [
      '序列粘贴的真实剪贴板写入与全局快捷键推进：需真实剪贴板，留给人工验收',
      'restart_elevated：会触发 UAC 并退出当前进程，留给人工验收',
      '拖到外部应用：本期未实现，见文档“暂缓项”',
    ],
    note: '隔离数据目录与便携目录上的真实 IPC 验收；不读写真实剪贴板，不替代人工采集/粘贴验收。便携模式使用复制的调试版 exe 与合成 portable.txt。',
  }, null, 2))
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2))
} catch(error) {
  console.error(error.message)
  if(logs) console.error(logs.slice(-1800))
  process.exitCode = 1
} finally {
  await stop()
  rmSync(work, { recursive: true, force: true })
}
