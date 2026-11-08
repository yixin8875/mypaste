// @vitest-environment jsdom
import React, { act, StrictMode, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Clip, Snapshot } from './clipboard-service'
const { api } = vi.hoisted(() => ({ api: { snapshot: vi.fn(), item: vi.fn(), search: vi.fn(), update: vi.fn(), purge: vi.fn(), createCollection: vi.fn(), settings: vi.fn(), copy: vi.fn(), paste: vi.fn(), image: vi.fn(), thumbnail: vi.fn(), version: vi.fn(), checkUpdate: vi.fn(), installUpdate: vi.fn(), openLink: vi.fn(), hideQuick: vi.fn(), subscribe: vi.fn() } }))
vi.mock('./clipboard-service', () => ({ clipboardService: api, native: true, errorMessage: (e: unknown) => e instanceof Error ? e.message : String(e) }))
import App, { Editable } from './App'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root, host: HTMLDivElement, quickOpen: () => void, changed: () => void, data: Snapshot
const fullText = '完整正文'.repeat(80) + '关键词在摘要之外'
const clip: Clip = { id: 1, title: '测试记录', content: fullText, type: 'text', source: '测试应用', time: '10:00', day: '今天', capturedAt: 1794090000000, deletedAt: null, deleted: false, favorite: false, collections: [], note: '', fileSize: 0, fileModifiedAt: null, files: [], lastUsedAt: null, useCount: 0 }
const settle = async () => { for(let i = 0; i < 8; i++) await Promise.resolve() }
const render = async (node: React.ReactNode) => { await act(async () => { root.render(node); await settle() }) }
const click = async (selector: string) => { await act(async () => { host.querySelector<HTMLButtonElement>(selector)!.click(); await settle() }) }
const clickText = async (selector: string, text: string) => { const element = [...host.querySelectorAll<HTMLButtonElement>(selector)].find(candidate => candidate.textContent?.includes(text)); await act(async () => { element!.click(); await settle() }) }
const choose = async (select: HTMLSelectElement, value: string) => { await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value); select.dispatchEvent(new Event('change', { bubbles: true })); await settle() }) }
const type = async (input: HTMLInputElement | HTMLTextAreaElement, value: string) => { await act(async () => { Object.getOwnPropertyDescriptor(input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); await settle() }) }
const focus = async (input: HTMLElement) => { await act(async () => input.focus()) }
const blur = async (input: HTMLElement) => { await act(async () => { input.blur(); await settle() }) }
const key = async (input: HTMLElement, value: string) => { await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })); await settle() }) }
const openQuick = async () => { await act(async () => { quickOpen(); await settle() }) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
beforeEach(() => {
  vi.resetAllMocks()
  data = { items: [{ ...clip, content: fullText.slice(0, 240) }], collections: [], settings: { paused: false, retentionDays: 30, maxItems: 500, shortcut: 'Ctrl+Shift+V', excludedApps: [] }, status: { captureState: 'running', captureError: null, shortcutRegistered: true, shortcutError: null }, dataDir: 'C:/synthetic-test-data' }
  api.snapshot.mockImplementation(async () => structuredClone(data)); api.item.mockImplementation(async () => ({ ...clip })); api.search.mockResolvedValue([1])
  api.subscribe.mockImplementation(async (change, quick) => { changed = change; quickOpen = quick; return vi.fn() })
  api.update.mockResolvedValue(undefined); api.copy.mockResolvedValue(undefined); api.image.mockResolvedValue(''); api.thumbnail.mockResolvedValue(''); api.hideQuick.mockResolvedValue(undefined); api.settings.mockResolvedValue(undefined)
  api.version.mockResolvedValue('0.2.0'); api.checkUpdate.mockResolvedValue(null); api.installUpdate.mockResolvedValue(undefined)
  Element.prototype.scrollIntoView = vi.fn()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers() })
describe('原生适配异步交互', () => {
  it('详情读完整正文，复制按ID而非摘要', async () => {
    await render(<App/>); expect(host.querySelector('pre')?.textContent).toBe(fullText)
    await click('.primary-actions .primary-button'); expect(api.copy).toHaveBeenCalledWith(1)
    expect(host.querySelector('[role="status"]')?.textContent).toBe('已复制到剪贴板')
  })
  it('文件记录展示大小、修改时间与超大文件提示并仍按ID复制', async () => {
    const big = 2 * 1024 ** 3
    const fileClip: Clip = { ...clip, type: 'file', content: 'C:\\Synthetic\\video.mp4\nC:\\Synthetic\\图标', fileSize: big, fileModifiedAt: 1794090000000, files: [{ path: 'C:\\Synthetic\\video.mp4', size: big, modifiedAt: 1794090000000, isDir: false }, { path: 'C:\\Synthetic\\图标', size: null, modifiedAt: null, isDir: true }] }
    data.items = [{ ...fileClip }]
    api.item.mockResolvedValue({ ...fileClip })
    await render(<App/>)
    expect(host.querySelectorAll('.file-row')).toHaveLength(2)
    expect(host.querySelector('.file-row span')?.textContent).toBe('C:\\Synthetic\\video.mp4')
    expect(host.querySelector('.file-row em')?.textContent).toContain('2.0 GB')
    expect(host.querySelector('.file-warning')?.textContent).toContain('达到 1 GB')
    expect(host.querySelector('.primary-actions .primary-button')?.textContent).toContain('复制文件')
    await click('.primary-actions .primary-button'); expect(api.copy).toHaveBeenCalledWith(1)
  })
  it('单个图片文件显示缩略图与预览，仍按文件复制', async () => {
    const photo: Clip = { ...clip, type: 'file', title: 'photo.png', content: 'C:\\Synthetic\\photo.png', fileSize: 2048, fileModifiedAt: 1794090000000, files: [{ path: 'C:\\Synthetic\\photo.png', size: 2048, modifiedAt: 1794090000000, isDir: false }] }
    data.items = [{ ...photo }]; api.item.mockResolvedValue({ ...photo })
    api.thumbnail.mockResolvedValue('data:image/png;base64,THUMB')
    api.image.mockResolvedValue('data:image/png;base64,FULL')
    await render(<App/>)
    await act(async () => { await settle() })
    expect(api.thumbnail).toHaveBeenCalledWith(1)
    expect(host.querySelector('.clip-thumb img')?.getAttribute('src')).toBe('data:image/png;base64,THUMB')
    expect(host.querySelector('.file-preview .native-image-preview img')?.getAttribute('src')).toBe('data:image/png;base64,FULL')
    await click('.primary-actions .primary-button'); expect(api.copy).toHaveBeenCalledWith(1)
  })
  it('原生快照失败不回退为虚构记录', async () => {
    api.snapshot.mockRejectedValue(new Error('数据库不可读')); await render(<App/>)
    expect(host.querySelectorAll('.clip-row')).toHaveLength(0); expect(host.querySelector('[role="alert"]')?.textContent).toContain('数据库不可读')
  })
  it('失败写入提示不被后台采集刷新吞掉', async () => {
    api.update.mockRejectedValue(new Error('磁盘空间不足')); await render(<App/>); await click('[aria-label="收藏记录"]')
    await act(async () => { changed(); await settle() }); expect(host.querySelector('[role="alert"]')?.textContent).toContain('磁盘空间不足')
  })
  it('新一轮呼出不被上一轮复制完成关闭', async () => {
    const copying = deferred<void>(); api.copy.mockReturnValue(copying.promise)
    await render(<App/>); await openQuick(); await key(host.querySelector('[aria-label="快捷搜索"]')!, 'Enter'); await openQuick()
    await act(async () => { copying.resolve(); await settle() }); expect(host.querySelector('.quick-modal')).not.toBeNull(); expect(api.hideQuick).not.toHaveBeenCalled()
  })
  it('隐藏失败保留弹层并允许重试', async () => {
    api.hideQuick.mockRejectedValueOnce(new Error('窗口暂时不可用')).mockResolvedValue(undefined)
    await render(<App/>); await openQuick(); await click('[aria-label="关闭"]'); expect(host.querySelector('.quick-modal')).not.toBeNull()
    await click('[aria-label="关闭"]'); expect(host.querySelector('.quick-modal')).toBeNull(); expect(api.hideQuick).toHaveBeenCalledTimes(2)
  })
  it('切换记录后旧记录保存失败仍能找回备注草稿', async () => {
    data.items.push({ ...clip, id: 2, title: '第二条记录' })
    api.item.mockImplementation(async (id: number) => ({ ...clip, id, title: id === 1 ? '测试记录' : '第二条记录' }))
    const saving = deferred<void>()
    api.update.mockImplementation(async () => { await saving.promise; throw new Error('存储失败') })
    await render(<App/>); const note = host.querySelector<HTMLTextAreaElement>('[aria-label="备注"]')!
    await focus(note); await type(note, '切换后也不能丢失的长备注'); await blur(note)
    await click('.clip-row:nth-of-type(1)')
    await act(async () => { host.querySelectorAll<HTMLButtonElement>('.clip-row')[1].click(); await settle() })
    expect(host.querySelector('.detail-title-row')?.textContent).toContain('第二条记录')
    await act(async () => { saving.resolve(); await settle() })
    await act(async () => { host.querySelectorAll<HTMLButtonElement>('.clip-row')[0].click(); await settle() })
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="备注"]')!.value).toBe('切换后也不能丢失的长备注')
  })
  it('StrictMode卸载释放迟到的事件订阅', async () => {
    const cleanups: ReturnType<typeof vi.fn>[] = []
    api.subscribe.mockImplementation(async () => { const cleanup = vi.fn(); cleanups.push(cleanup); return cleanup })
    await render(<StrictMode><App/></StrictMode>); expect(cleanups).toHaveLength(2); expect(cleanups[0]).toHaveBeenCalledTimes(1); expect(cleanups[1]).not.toHaveBeenCalled()
    await act(async () => root.render(null)); expect(cleanups[1]).toHaveBeenCalledTimes(1)
  })
  it('完整正文搜索不受摘要截断限制', async () => {
    await render(<App/>); await type(host.querySelector('[aria-label="搜索记录"]')!, '关键词在摘要之外')
    await act(async () => { await new Promise(r => setTimeout(r, 180)); await settle() })
    expect(api.search).toHaveBeenCalledWith('关键词在摘要之外'); expect(host.querySelectorAll('.clip-row')).toHaveLength(1)
  })
  it('按来源筛选记录并可从详情排除该应用', async () => {
    data.items = [{ ...clip, id: 1, title: '来自 Alpha', source: 'Alpha' }, { ...clip, id: 2, title: '来自 Beta', source: 'Beta' }]
    api.item.mockImplementation(async (id: number) => ({ ...clip, id, title: id === 1 ? '来自 Alpha' : '来自 Beta', source: id === 1 ? 'Alpha' : 'Beta' }))
    api.search.mockResolvedValue([1, 2])
    await render(<App/>)
    await choose(host.querySelector<HTMLSelectElement>('[aria-label="来源应用筛选"]')!, 'Beta')
    expect(host.querySelectorAll('.clip-row')).toHaveLength(1)
    expect(host.querySelector('.clip-row-title')?.textContent).toBe('来自 Beta')
    await click('.exclude-link')
    expect(api.settings).toHaveBeenCalledWith({ excludedApps: ['Beta'] })
    expect(host.querySelector('[role="status"]')?.textContent).toContain('将不再记录来自 Beta')
  })
  it('图片行按需加载缩略图', async () => {
    const imageClip: Clip = { ...clip, id: 7, title: '一张截图', type: 'image', content: '' }
    data.items = [{ ...imageClip }]; api.item.mockResolvedValue(imageClip)
    api.thumbnail.mockResolvedValue('data:image/png;base64,AA==')
    await render(<App/>)
    expect(host.querySelector('.clip-row .clip-thumb img')?.getAttribute('src')).toBe('data:image/png;base64,AA==')
    expect(api.thumbnail).toHaveBeenCalledWith(7)
  })
  it('快捷窗口支持类型筛选、使用频率排序并保留未发送粘贴的原因', async () => {
    const used: Clip = { ...clip, id: 3, title: '常用旧记录', content: '旧', capturedAt: 1700000000000, useCount: 9, lastUsedAt: 1700000000000 }
    const recent: Clip = { ...clip, id: 4, title: '新的文本', content: '新', capturedAt: 1794090000000, useCount: 0 }
    const picture: Clip = { ...clip, id: 5, title: '一张截图', type: 'image', content: '', capturedAt: 1794090000000 }
    data.items = [{ ...used }, { ...recent }, { ...picture }]
    api.item.mockImplementation(async (id: number) => data.items.find(c => c.id === id)!)
    api.search.mockResolvedValue([3, 4, 5])
    api.paste.mockResolvedValue({ copied: true, status: 'manual_required', reason: '已复制，请在目标应用按 Ctrl+V' })
    await render(<App/>); await openQuick()
    await clickText('.quick-chip', '图片')
    expect(host.querySelectorAll('.quick-row')).toHaveLength(1)
    await clickText('.quick-chip', '全部')
    await click('.quick-sort')
    expect(host.querySelector('.quick-row strong')?.textContent).toBe('常用旧记录')
    const search = host.querySelector<HTMLInputElement>('[aria-label="快捷搜索"]')!
    await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); await settle() })
    expect(host.querySelector('.quick-modal')).not.toBeNull()
    expect(host.querySelector('.quick-notice')?.textContent).toContain('已复制，请在目标应用按 Ctrl+V')
    expect(api.hideQuick).not.toHaveBeenCalled()
  })
  it('设置页检查并安装更新', async () => {
    api.checkUpdate.mockResolvedValue({ version: '0.3.0', currentVersion: '0.2.0', notes: '修复与改进', date: null })
    await render(<App/>)
    await click('header [aria-label="设置"]')
    expect(host.textContent).toContain('当前版本 0.2.0')
    await clickText('.settings-modal button', '检查更新')
    expect(host.textContent).toContain('发现新版本 0.3.0')
    await clickText('.settings-modal button', '下载并安装')
    expect(api.installUpdate).toHaveBeenCalledTimes(1)
  })
})
describe('编辑草稿', () => {
  it('失败保存保留草稿供失焦重试', async () => {
    const save = vi.fn().mockResolvedValue(false)
    await render(<Editable label="测试输入" value="原内容" maxLength={200} disabled={false} save={save}/>); const input = host.querySelector('input')!
    await focus(input); await type(input, '不能丢失的草稿'); await blur(input)
    expect(input.value).toBe('不能丢失的草稿'); expect(input.getAttribute('aria-invalid')).toBe('true')
    await focus(input); await blur(input); expect(save).toHaveBeenCalledTimes(2)
  })
  it('延迟保存A完成不覆盖重新聚焦后输入的B', async () => {
    const saved = deferred<boolean>()
    function Harness() { const [value, setValue] = useState('原内容'); return <Editable label="测试输入" value={value} maxLength={200} disabled={false} save={async next => { const ok = await saved.promise; if(ok) setValue(next); return ok }}/> }
    await render(<Harness/>); const input = host.querySelector('input')!
    await focus(input); await type(input, 'A'); await blur(input); await focus(input); await type(input, 'B')
    await act(async () => { saved.resolve(true); await settle() }); expect(document.activeElement).toBe(input); expect(input.value).toBe('B')
  })
})
