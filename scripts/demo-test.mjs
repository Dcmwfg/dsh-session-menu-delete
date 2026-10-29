#!/usr/bin/env node
// demo/index.html 的静态自检：不开浏览器，只查结构、资源、语法、时间轴。
// 用法：node scripts/demo-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoPath = path.join(root, 'demo', 'index.html');

let pass = 0;
const fails = [];
function ok(name, cond, detail){
  if (cond){ pass++; console.log('  ok   ' + name); }
  else { fails.push(name + (detail ? ' -> ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' -> ' + detail : '')); }
}

console.log('demo/index.html');

if (!fs.existsSync(demoPath)){
  console.log('  FAIL 文件不存在');
  process.exit(1);
}
const html = fs.readFileSync(demoPath, 'utf8');
const size = Buffer.byteLength(html);

ok('文件存在且足够大', size > 20000, size + 'B');

// 1. 零外部依赖
const extAttrs = [...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']*)["']/gi)].map(function(m){ return m[1]; });
const externalRefs = extAttrs.filter(function(u){
  return /^(?:https?:)?\/\//i.test(u) || /\.(?:js|css|png|jpe?g|gif|webp|svg|woff2?|ttf|mp3|wav|ogg)(?:\?|#|$)/i.test(u);
});
ok('没有外链资源', externalRefs.length === 0, externalRefs.join(', '));
ok('没有 CSS @import', !/@import/i.test(html));
ok('没有 url(http 引用', !/url\(\s*["']?https?:/i.test(html));
ok('没有 fetch', !/\bfetch\s*\(/.test(html));
ok('没有 XMLHttpRequest', !/XMLHttpRequest/.test(html));

// 2. 内联脚本语法
const m = html.match(/<script>([\s\S]*?)<\/script>/);
ok('有且只有一个内联 script', !!m && (html.match(/<script/g) || []).length === 1);
const script = m ? m[1] : '';
let syntaxErr = null;
try { new vm.Script(script, { filename: 'demo-inline.js' }); } catch (e) { syntaxErr = e.message; }
ok('内联脚本语法正确', !syntaxErr, syntaxErr || '');

// 3. 零宽 / 异常字符
const badChars = [];
for (const ch of html){
  const c = ch.codePointAt(0);
  if (c === 0x200b || c === 0x200c || c === 0x200d || c === 0x200e || c === 0x200f ||
      c === 0x2060 || c === 0xfeff || c === 0x00a0 || c === 0x2028 || c === 0x2029){
    badChars.push('U+' + c.toString(16).toUpperCase());
  }
}
ok('没有零宽字符', badChars.length === 0, [...new Set(badChars)].join(','));

// 4. 音频引擎
const audioFns = ['audioInit','makeIR','tone','noiseHit','sfxClick','sfxTick','sfxOpen','sfxClose',
                  'sfxThud','sfxDelete','sfxGone','sfxOk','sfxBubble','sfxDeep'];
const missingAudio = audioFns.filter(function(f){ return !new RegExp('function\\s+' + f + '\\s*\\(').test(script); });
ok('音频函数齐全 (' + audioFns.length + ' 个)', missingAudio.length === 0, missingAudio.join(','));
ok('使用 WebAudio 振荡器', /createOscillator/.test(script));
ok('使用卷积混响', /createConvolver/.test(script));

// 5. 场景
let sceneCount = 0;
for (let i = 1; i <= 8; i++){ if (new RegExp('function\\s+scene' + i + '\\s*\\(').test(script)) sceneCount++; }
ok('八个场景函数齐全', sceneCount === 8, 'only ' + sceneCount);
const scenesLine = (script.match(/var SCENES\s*=\s*\[([\s\S]*?)\];/) || [])[1] || '';
ok('SCENES 表列了 8 场', (scenesLine.match(/scene\d/g) || []).length === 8);

// 6. 时间轴
const tl = script.match(/var TOTAL\s*=\s*([\d.]+)[\s\S]*?var S1=([\d.]+),\s*S2=([\d.]+),\s*S3=([\d.]+),\s*S4=([\d.]+),\s*S5=([\d.]+),\s*S6=([\d.]+),\s*S7=([\d.]+),\s*S8=([\d.]+),\s*END=([\d.]+)/);
ok('时间轴常量可解析', !!tl);
const TOTAL = tl ? +tl[1] : 0;
if (tl){
  const marks = [+tl[2], +tl[3], +tl[4], +tl[5], +tl[6], +tl[7], +tl[8], +tl[9]];
  const END = +tl[10];
  ok('起点为 0', marks[0] === 0, String(marks[0]));
  let ascending = true;
  for (let i = 1; i < marks.length; i++){ if (marks[i] <= marks[i-1]) ascending = false; }
  ok('场景起点严格递增', ascending, marks.join(','));
  ok('END 等于 TOTAL', END === TOTAL, END + ' vs ' + TOTAL);
  ok('总时长 40-90 秒', TOTAL >= 40 && TOTAL <= 90, TOTAL + 's');
}

// 7. 音效时间表
const cueBlock = (script.match(/var CUES\s*=\s*\[([\s\S]*?)\n\];/) || [])[1] || '';
const cueTimes = [...cueBlock.matchAll(/\[\s*([\d.]+)\s*,/g)].map(function(x){ return +x[1]; });
ok('音效数量 >= 25', cueTimes.length >= 25, String(cueTimes.length));
let cueAsc = true;
for (let i = 1; i < cueTimes.length; i++){ if (cueTimes[i] <= cueTimes[i-1]) cueAsc = false; }
ok('音效时间严格递增', cueAsc);
ok('音效都在片长内', cueTimes.every(function(t){ return t >= 0 && t < TOTAL; }), 'max ' + Math.max.apply(null, cueTimes) + ' / ' + TOTAL);
const cueFns = [...new Set([...cueBlock.matchAll(/sfx[A-Za-z]+/g)].map(function(x){ return x[0]; }))];
const unknownCue = cueFns.filter(function(f){ return audioFns.indexOf(f) < 0; });
ok('音效引用都存在', unknownCue.length === 0, unknownCue.join(','));

// 8. 交互与自适应
ok('有 rAF 主循环', /requestAnimationFrame\s*\(\s*loop\s*\)/.test(script));
ok('有 DPR 自适应', /devicePixelRatio/.test(script) && /setTransform/.test(script));
ok('有 resize 回填', /addEventListener\('resize'/.test(script));
ok('空格暂停', /e\.code === 'Space'/.test(script));
ok('R 重播', /e\.key === 'r' \|\| e\.key === 'R'/.test(script));
ok('M 静音', /MUTED = !MUTED/.test(script));
ok('F 全屏', /requestFullscreen/.test(script));
ok('有开始遮罩', /id="gate"/.test(html));
ok('有进度条', /id="fill"/.test(html));

// 9. 定格与自动播
ok('支持 ?t= 定格', /QS\.get\('t'\)/.test(script));
ok('支持 ?auto=1', /QS\.get\('auto'\) === '1'/.test(script));

// 10. 文案
ok('仓库地址正确', script.indexOf('github.com/Dcmwfg/dsh-session-menu-delete') >= 0);
ok('标了版本 0.1.1', script.indexOf('0.1.1') >= 0);

console.log('');
if (fails.length){
  console.log('失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项');
  for (const f of fails) console.log(' - ' + f);
  process.exit(1);
}
console.log('全部通过：' + pass + ' 项');
