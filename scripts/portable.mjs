#!/usr/bin/env node
// Build a portable folder from an existing release executable. The app treats a
// `portable.txt` marker beside the executable as a request to keep all data in
// `<exe folder>/data`; this script only arranges files and never runs the app.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function packagePortable({ exe, out }) {
  if(!existsSync(exe)) throw new Error(`找不到可执行文件：${exe}\n请先运行 npm run desktop:build，或传入 --exe <path>`)
  if(path.extname(exe).toLowerCase() !== '.exe') throw new Error(`需要 Windows 可执行文件：${exe}`)
  mkdirSync(out, { recursive: true })
  const target = path.join(out, path.basename(exe))
  copyFileSync(exe, target)
  writeFileSync(path.join(out, 'portable.txt'), 'MyPaste portable mode: data is stored in the data folder beside this file.\r\n', 'utf8')
  writeFileSync(path.join(out, 'README.txt'), [
    'MyPaste 便携版',
    '',
    '1. 保持 portable.txt 与本程序在同一目录。删除该文件后，程序会改回使用系统应用数据目录。',
    '2. 数据保存在同目录的 data 文件夹（history.sqlite3、logs），WebView2 缓存写入同目录 webview2 文件夹。备份时整体复制这两个文件夹。',
    '3. 便携模式忽略 storage.json 中记录的存储位置，设置页不能更改数据目录。',
    '4. 需要系统已安装 Microsoft Edge WebView2 Runtime（Windows 11 通常自带）。',
    '',
    '此目录由 scripts/portable.mjs 生成；升级时替换 exe 即可，portable.txt 与 data 文件夹请保留。',
    '',
  ].join('\r\n'), 'utf8')
  return { exe: target, out, marker: path.join(out, 'portable.txt'), bytes: statSync(target).size }
}

function selfTest() {
  const dir = mkdtempSync(path.join(tmpdir(), 'mypaste-portable-'))
  try {
    const exe = path.join(dir, 'MyPaste.exe')
    writeFileSync(exe, 'synthetic executable placeholder')
    const result = packagePortable({ exe, out: path.join(dir, 'package') })
    const marker = readFileSync(result.marker, 'utf8')
    if(!marker.includes('portable mode')) throw new Error('portable.txt 内容不正确')
    if(!existsSync(path.join(result.out, 'MyPaste.exe'))) throw new Error('可执行文件未复制')
    if(!readFileSync(path.join(result.out, 'README.txt'), 'utf8').includes('portable.txt')) throw new Error('README.txt 缺少使用说明')
    console.log(JSON.stringify({ selfTest: 'passed', ...result }, null, 2))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function main() {
  const args = process.argv.slice(2)
  if(args.includes('--self-test')) return selfTest()
  const option = name => {
    const index = args.indexOf(`--${name}`)
    const value = index >= 0 ? args[index + 1] : undefined
    return value && !value.startsWith('--') ? path.resolve(value) : null
  }
  const exe = option('exe') ?? path.join(root, 'src-tauri', 'target', 'release', 'mypaste.exe')
  const out = option('out') ?? path.join(root, 'dist-portable', 'MyPaste')
  try {
    console.log(JSON.stringify({ packaged: packagePortable({ exe, out }) }, null, 2))
  } catch(error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

main()
