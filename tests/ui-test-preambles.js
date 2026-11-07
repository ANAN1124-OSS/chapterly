'use strict';

// 9 个渲染层模块单测（*-ui.test.js）共用的测试前导。只抽重复的两样：
//
// 1) 全局替身的保存与恢复：模块在 Node 里跑，有的要临时放一个假 document，
//    有的要打「没有 document / window」的边界（create() 只建表不碰 DOM）。
//    真身一律在模块加载时存下，test.after / finally 再放回去；
//    「原本是 undefined 就 delete」的语义保持不变。
// 2) readFileSync 静态闸门前导：renderer.js / index.html / 本域模块三份源码，
//    外加给正则闸门用的归一化代码视图——仓库工作区行尾是 CRLF，先归一成 LF；
//    注释里提 document / window 是在解释契约、不算越界，所以剥掉注释再看。
//
// makeEl / makeHost 等假 DOM 仍由各用例文件自己维护（有意变体，不统一）。
// 本文件不叫 *.test.js：`node --test "tests/**/*.test.js"` 不会把它当用例跑。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// 模块加载期替身：test.after 时按「原本没有就 delete，否则写回真身」恢复。
// 用法：restoreGlobalsAfter(test, ['document', 'window']);
function restoreGlobalsAfter(test, names) {
  const saved = new Map();
  for (const name of names) saved.set(name, globalThis[name]);
  test.after(() => {
    for (const name of names) {
      const value = saved.get(name);
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  });
}

// 用例体内临时藏起全局：同步执行 fn，无论抛不抛都在 finally 里放回真身。
// 用法：withoutGlobals(['document', 'window'], () => { ... });
function withoutGlobals(names, fn) {
  const saved = new Map();
  for (const name of names) {
    saved.set(name, globalThis[name]);
    delete globalThis[name];
  }
  try {
    return fn();
  } finally {
    for (const name of names) {
      const value = saved.get(name);
      if (value !== undefined) globalThis[name] = value;
    }
  }
}

// 剥掉块注释与整行 // 注释，供「模块里不许出现某实现」这类纯度闸门用。
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// 静态闸门前导：一次读齐三份源；rendererCode 行尾归一化，moduleCode 再剥注释。
function loadSourceGate(moduleFile) {
  const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
  const indexSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const moduleSrc = fs.readFileSync(path.join(ROOT, 'renderer', moduleFile), 'utf8');
  return {
    rendererSrc,
    rendererCode: rendererSrc.replace(/\r\n/g, '\n'),
    indexSrc,
    moduleSrc,
    moduleCode: stripComments(moduleSrc)
  };
}

module.exports = { loadSourceGate, restoreGlobalsAfter, withoutGlobals };
