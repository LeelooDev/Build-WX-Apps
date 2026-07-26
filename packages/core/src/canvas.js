import fs from 'node:fs'
import path from 'node:path'
import { readJsonLoose } from './util.js'

/**
 * 判断某个页面（含它用到的自定义组件）里有没有 canvas。
 *
 * 存在的理由是一条会**骗人**的失败：开发者工具的截图**不合成 `canvas type="2d"`
 * 的同层渲染内容**。画得好好的画布，截出来是一片空白，和"canvas 渲染失败"
 * 在像素上完全无法区分。
 *
 * 实测证据：把整块画布填成不透明红色，`getImageData` 显示 104160/104160 像素全部
 * 非透明，截图依然全白。
 *
 * 对着截图做判断的 AI 会直接得出「这个功能坏了」——所以只要页面里有 canvas，
 * 截图结果就必须带上这句警告。
 */

/** 顺着 usingComponents 递归收集页面涉及的所有 wxml */
function collectWxml (distDir, pagePath, seen = new Set()) {
  const key = pagePath.replace(/^\/+/, '')
  if (seen.has(key)) return []
  seen.add(key)

  const wxmlFile = path.join(distDir, `${key}.wxml`)
  const files = []
  if (fs.existsSync(wxmlFile)) files.push(wxmlFile)

  const json = readJsonLoose(path.join(distDir, `${key}.json`))
  const using = json?.usingComponents
  if (using && typeof using === 'object') {
    for (const ref of Object.values(using)) {
      if (typeof ref !== 'string') continue
      // 插件组件（plugin://）没有本地产物，跳过
      if (ref.startsWith('plugin://')) continue
      const resolved = ref.startsWith('/')
        ? ref.slice(1)
        : path.posix.normalize(path.posix.join(path.posix.dirname(key), ref))
      if (resolved.startsWith('..')) continue
      files.push(...collectWxml(distDir, resolved, seen))
    }
  }
  return files
}

const CANVAS_RE = /<canvas[\s/>]/i

/**
 * @param {string} distDir 编译产物目录
 * @param {string} pagePath 页面路径，形如 `pages/tree/index`
 * @returns {{has:boolean, files:string[]}}
 */
export function pageUsesCanvas (distDir, pagePath) {
  if (!distDir || !pagePath) return { has: false, files: [] }
  let files = []
  try {
    files = collectWxml(distDir, String(pagePath))
  } catch {
    return { has: false, files: [] }
  }
  const hits = []
  for (const f of files) {
    try {
      if (CANVAS_RE.test(fs.readFileSync(f, 'utf8'))) hits.push(path.relative(distDir, f))
    } catch {
      /* 读不到就当没有 */
    }
  }
  return { has: hits.length > 0, files: hits }
}

export const CANVAS_SCREENSHOT_WARNING =
  '⚠️ 本页含 canvas：开发者工具的截图不捕获 canvas type="2d" 的同层渲染内容，' +
  '画布区域空白**不代表**没画上去。要确认是否真的绘制了，用 wxctl eval / wx_eval 读像素：\n' +
  '  const c = /* 你的 canvas 2d context */; ' +
  'const d = c.getImageData(0,0,w,h).data; ' +
  'let n=0; for(let i=3;i<d.length;i+=4) if(d[i]) n++; return n;\n' +
  '  返回值 > 0 就说明画布上有内容。'
