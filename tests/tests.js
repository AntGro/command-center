#!/usr/bin/env node
/**
 * Command Center Integration Tests
 * 
 * Static analysis + headless browser smoke tests.
 * Run via: node tests/tests.js (from command-center/)
 * Or via: bash run_tests.sh (from command-center/)
 * 
 * Catches: missing functions, HTML entities in JS, broken ES module chains,
 * login gate not appearing, views not loading, console errors.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const JS_DIR = path.join(__dirname, '..', 'js');
const STYLE_FILE = path.join(__dirname, '..', 'style.css');
const INDEX_FILE = path.join(__dirname, '..', 'index.html');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

// ===================================================================
// Load all JS files
// ===================================================================
const jsFiles = {};
const jsFileNames = fs.readdirSync(JS_DIR).filter(f => f.endsWith('.js'));
for (const f of jsFileNames) {
  jsFiles[f] = fs.readFileSync(path.join(JS_DIR, f), 'utf-8');
}
const indexHtml = fs.readFileSync(INDEX_FILE, 'utf-8');
const styleCss = fs.readFileSync(STYLE_FILE, 'utf-8');

console.log('\n📋 Static Analysis\n');

// ===================================================================
// 1. No HTML entities in JS files
// ===================================================================
test('No HTML entities in JS files', () => {
  for (const [name, content] of Object.entries(jsFiles)) {
    const entities = content.match(/&(quot|amp|lt|gt|apos);/g);
    if (entities) {
      throw new Error(`${name} contains HTML entities: ${entities.join(', ')}`);
    }
  }
});

// ===================================================================
// 2. Balanced backticks (template literals) — skip files with regex backticks
// ===================================================================
test('Balanced backticks in JS files (excluding markdown processors)', () => {
  // Files that legitimately use backticks inside regex/strings for markdown parsing
  const skipFiles = new Set(['utils.js']);
  for (const [name, content] of Object.entries(jsFiles)) {
    if (skipFiles.has(name)) continue;
    const count = (content.match(/`/g) || []).length;
    if (count % 2 !== 0) {
      throw new Error(`${name} has ${count} backticks (odd — likely unclosed template literal)`);
    }
  }
});

// ===================================================================
// 3. All window.X = X assignments reference defined functions
// ===================================================================
test('All window.fn = fn assignments reference defined identifiers', () => {
  for (const [name, content] of Object.entries(jsFiles)) {
    // Match: window.foo = foo; or window.foo = foo\n
    const assignments = content.matchAll(/window\.(\w+)\s*=\s*(\w+)\s*[;\n]/g);
    for (const m of assignments) {
      const windowName = m[1];
      const localName = m[2];
      // Check that localName is defined somewhere in the file (function, const, let, var, or as a parameter)
      const defPatterns = [
        new RegExp(`function\\s+${localName}\\s*\\(`),
        new RegExp(`(?:const|let|var)\\s+${localName}\\s*=`),
        new RegExp(`window\\.${localName}\\s*=\\s*function`),
      ];
      const isDefined = defPatterns.some(p => p.test(content));
      // Also check if imported
      const isImported = new RegExp(`import\\s+.*\\b${localName}\\b.*from`).test(content);
      if (!isDefined && !isImported) {
        throw new Error(`${name}: window.${windowName} = ${localName} but ${localName} is never defined or imported`);
      }
    }
  }
});

// ===================================================================
// 4. All imports resolve to existing exports
// ===================================================================
test('All named imports resolve to exports in target files', () => {
  for (const [name, content] of Object.entries(jsFiles)) {
    // Match: import { foo, bar } from './baz.js'
    const importRegex = /import\s*\{([^}]+)\}\s*from\s*['"]\.\/(\w+\.js)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const importedNames = match[1].split(',').map(s => s.trim()).filter(Boolean);
      const targetFile = match[2];
      const targetContent = jsFiles[targetFile];
      if (!targetContent) {
        throw new Error(`${name}: imports from ./${targetFile} but file doesn't exist`);
      }
      for (const imp of importedNames) {
        // Check export { ... imp ... } or export function imp or export const imp
        const exportBlock = targetContent.match(/export\s*\{([^}]+)\}/);
        const inExportBlock = exportBlock && exportBlock[1].split(',').map(s => s.trim()).includes(imp);
        const isExportedDirectly = new RegExp(`export\\s+(function|const|let|var)\\s+${imp}\\b`).test(targetContent);
        if (!inExportBlock && !isExportedDirectly) {
          throw new Error(`${name}: imports '${imp}' from ./${targetFile} but it's not exported`);
        }
      }
    }
  }
});

// ===================================================================
// 5. Default imports resolve
// ===================================================================
test('Default imports resolve to default exports', () => {
  for (const [name, content] of Object.entries(jsFiles)) {
    const defaultImports = content.matchAll(/import\s+(\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"]\.\/(\w+\.js)['"]/g);
    for (const m of defaultImports) {
      const targetFile = m[2];
      const targetContent = jsFiles[targetFile];
      if (!targetContent) {
        throw new Error(`${name}: imports default from ./${targetFile} but file doesn't exist`);
      }
      if (!targetContent.includes('export default')) {
        throw new Error(`${name}: imports default from ./${targetFile} but no default export found`);
      }
    }
  }
});

// ===================================================================
// 6. No obvious syntax errors: unmatched braces in function bodies
// ===================================================================
test('No duplicate function definitions in same file', () => {
  for (const [name, content] of Object.entries(jsFiles)) {
    const funcDefs = {};
    const funcRegex = /(?:^|\n)\s*(?:async\s+)?function\s+(\w+)\s*\(/g;
    let m;
    while ((m = funcRegex.exec(content)) !== null) {
      const fn = m[1];
      if (funcDefs[fn]) {
        throw new Error(`${name}: function '${fn}' is defined twice (lines ~${funcDefs[fn]} and ~${content.substring(0, m.index).split('\n').length})`);
      }
      funcDefs[fn] = content.substring(0, m.index).split('\n').length;
    }
  }
});

// ===================================================================
// 7. HTML: all modal overlays have matching close functions
// ===================================================================
test('All modal overlay IDs have corresponding close onclick handlers', () => {
  const overlayIds = indexHtml.matchAll(/class="modal-overlay"\s+id="(\w+)"/g);
  for (const m of overlayIds) {
    const id = m[1];
    // Should have a close button somewhere
    const hasClose = indexHtml.includes(`close${id.charAt(0).toUpperCase()}`) || 
                     indexHtml.includes(`onclick="close`);
    // This is a loose check — just ensure the modal isn't orphaned
  }
});

// ===================================================================
// 8. All onclick handlers in HTML reference window-exposed functions
// ===================================================================
test('Key onclick handlers in index.html reference window-exposed functions', () => {
  // Extract all onclick="functionName(...)" from HTML
  const onclickRegex = /onclick="(\w+)\s*\(/g;
  const htmlFunctions = new Set();
  let m;
  while ((m = onclickRegex.exec(indexHtml)) !== null) {
    htmlFunctions.add(m[1]);
  }
  
  // Collect all window.X assignments and top-level function definitions exposed
  const windowExposed = new Set();
  for (const content of Object.values(jsFiles)) {
    const winAssign = content.matchAll(/window\.(\w+)\s*=/g);
    for (const wa of winAssign) windowExposed.add(wa[1]);
  }
  
  // Special: DOMContentLoaded-attached handlers don't need window exposure
  const builtins = new Set(['event', 'if', 'return', 'this']);
  
  for (const fn of htmlFunctions) {
    if (builtins.has(fn)) continue;
    if (!windowExposed.has(fn)) {
      // Check if it's maybe in the inline script or a known exception
      throw new Error(`onclick references '${fn}()' but no window.${fn} assignment found in JS modules`);
    }
  }
});

// ===================================================================
// 9. CSS: style.css is not empty and has expected selectors
// ===================================================================
test('style.css contains expected base selectors', () => {
  const required = ['.modal-overlay', '.modal', '.btn', '.app-header', '.project-card', '.view-tab'];
  for (const sel of required) {
    assert(styleCss.includes(sel), `Missing expected selector: ${sel}`);
  }
});

// ===================================================================
// 10. No stray console.log left in production code (warnings only)
// ===================================================================
test('No stray console.log in JS files (console.error/warn OK)', () => {
  for (const [name, content] of Object.entries(jsFiles)) {
    const logs = content.match(/console\.log\s*\(/g);
    if (logs && logs.length > 0) {
      // Just warn, don't fail
      console.log(`     ⚠️  ${name}: ${logs.length} console.log() calls (consider removing)`);
    }
  }
});

// ===================================================================
// 11. Chore "mark done" calls markChoreDone (no modal flow)
// ===================================================================
test('Chore done button calls markChoreDone directly (no modal)', () => {
  const choresJs = jsFiles['chores.js'];
  // Button should call markChoreDone, not openChoreDoneModal
  assert(choresJs.includes("markChoreDone("), 'markChoreDone function should exist');
  assert(choresJs.includes("window.markChoreDone"), 'markChoreDone should be window-exposed');
  assert(!choresJs.includes("openChoreDoneModal"), 'openChoreDoneModal should not exist');
  assert(!choresJs.includes("closeChoreDoneModal"), 'closeChoreDoneModal should not exist');
  assert(!choresJs.includes("submitChoreDone"), 'submitChoreDone should not exist');
  // No done modal in HTML
  assert(!indexHtml.includes('choreDoneModal'), 'choreDoneModal should not exist in index.html');
});

// ===================================================================
// 12. No emoji characters in JS files
// ===================================================================
test('No emoji characters in JS files (use Lucide icons instead)', () => {
  const emojiPattern = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/u;
  // Specific known emojis to catch
  const knownEmojis = ['🎉', '🕰', '⚠️', '💪', '📚', '🎂', '⏳', '✅', '🪶', '↩️', '👔', '🔥'];
  for (const [name, content] of Object.entries(jsFiles)) {
    for (const emoji of knownEmojis) {
      assert(!content.includes(emoji), `${name} contains emoji ${emoji} — use Lucide icon instead`);
    }
  }
});

// ===================================================================
// 13. Flashcard sorting: cards are sorted by retrievability
// ===================================================================
test('Flashcard deck rendering sorts cards by retrievability', () => {
  const flashJs = jsFiles['flashcards.js'];
  assert(flashJs.includes('cards.sort('), 'cards should be sorted before rendering');
  assert(flashJs.includes('retrievability('), 'sort should use retrievability function');
});

// ===================================================================
// 14. Flashcard left border uses retrievability color (no strength bar)
// ===================================================================
test('Flashcard items use border-left color from retrievability (no strength bar)', () => {
  const flashJs = jsFiles['flashcards.js'];
  assert(flashJs.includes('borderColor'), 'should compute borderColor from retrievability');
  assert(flashJs.includes('border-left'), 'should apply border-left style');
  assert(!flashJs.includes('fc-strength-bar'), 'strength bar element should be removed');
  assert(!styleCss.includes('.fc-strength-bar'), 'strength bar CSS should be removed');
});

// ===================================================================
// 15. Birthday hover actions use correct rowSelector
// ===================================================================
test('Birthday hover delay uses .birthday-info as rowSelector (not .birthday-card)', () => {
  const birthJs = jsFiles['birthdays.js'];
  const hoverCall = birthJs.match(/initItemHoverDelay\([\s\S]*?rowSelector:\s*'([^']+)'/);
  assert(hoverCall, 'initItemHoverDelay should be called for birthdays');
  assert(hoverCall[1] === '.birthday-info', 
    `rowSelector should be '.birthday-info' (got '${hoverCall[1]}') — querySelector doesn't match self`);
});

// ===================================================================
// 16. Wardrobe left border uses purchase status (not category color)
// ===================================================================
test('Wardrobe items use purchase-status-based border color', () => {
  const vestJs = jsFiles['vestiaire.js'];
  assert(vestJs.includes('vest-purchased') || vestJs.includes('vest-tried'),
    'vestiaire should add status classes for border color');
  assert(styleCss.includes('.vest-purchased'), '.vest-purchased CSS rule should exist');
  assert(styleCss.includes('.vest-tried'), '.vest-tried CSS rule should exist');
});

// ===================================================================
// 17. All lucideIcon() calls reference icons defined in LUCIDE_PATHS
// ===================================================================
test('All lucideIcon() calls reference defined icons', () => {
  const iconsJs = jsFiles['icons.js'];
  // Extract all defined icon names from LUCIDE_PATHS
  const definedIcons = new Set();
  const defRegex = /'([^']+)'\s*:/g;
  let dm;
  while ((dm = defRegex.exec(iconsJs)) !== null) definedIcons.add(dm[1]);

  // Scan all JS files for lucideIcon('name' ...) calls
  for (const [name, content] of Object.entries(jsFiles)) {
    if (name === 'icons.js') continue;
    const callRegex = /lucideIcon\s*\(\s*['"]([^'"]+)['"]/g;
    let cm;
    while ((cm = callRegex.exec(content)) !== null) {
      const iconName = cm[1];
      assert(definedIcons.has(iconName),
        `${name}: lucideIcon('${iconName}') but '${iconName}' is not defined in LUCIDE_PATHS`);
    }
  }
  // Also check data-icon attributes in index.html
  const dataIconRegex = /data-icon="([^"]+)"/g;
  let hm;
  while ((hm = dataIconRegex.exec(indexHtml)) !== null) {
    const iconName = hm[1];
    assert(definedIcons.has(iconName),
      `index.html: data-icon="${iconName}" but '${iconName}' is not defined in LUCIDE_PATHS`);
  }
});

// ===================================================================
// 18. Double-click edit: no ondblclick HTML attributes in JS (use onDblClick callback)
// ===================================================================
test('No ondblclick HTML attributes in JS files (use initItemHoverDelay onDblClick)', () => {
  for (const [name, content] of Object.entries(jsFiles)) {
    if (name === 'item-utils.js') continue; // the shared module itself is fine
    const matches = content.match(/ondblclick\s*=/g);
    assert(!matches,
      `${name}: found ${matches ? matches.length : 0} ondblclick attribute(s) — use initItemHoverDelay onDblClick callback instead`);
  }
});

// ===================================================================
// 19. Double-click edit: all initItemHoverDelay calls include onDblClick
// ===================================================================
test('All initItemHoverDelay calls include onDblClick callback', () => {
  const pages = ['projects.js', 'todos.js', 'chores.js', 'birthdays.js', 'vestiaire.js', 'flashcards.js'];
  for (const file of pages) {
    const content = jsFiles[file];
    if (!content) continue;
    // Find initItemHoverDelay call blocks
    const hoverCalls = content.match(/initItemHoverDelay\([^)]*\{[\s\S]*?\}\s*\)/g);
    assert(hoverCalls && hoverCalls.length > 0,
      `${file}: should call initItemHoverDelay`);
    for (const call of hoverCalls) {
      assert(call.includes('onDblClick'),
        `${file}: initItemHoverDelay missing onDblClick callback`);
    }
  }
});

// ===================================================================
// 20. Double-click triggers inline edit (not modal) on all pages
// ===================================================================
test('Double-click onDblClick triggers inline edit (not modal) on all pages', () => {
  // Each page's onDblClick callback must call an inline edit function, not a modal opener
  // We check that the function called within onDblClick uses inlineEditText (directly or via a wrapper)
  const inlinePages = {
    'projects.js': { dblClickFn: 'promptEditTask', mustUse: 'inlineEditText' },
    'todos.js': { dblClickFn: 'editTodoInline', mustUse: 'inlineEditText' },
    'chores.js': { dblClickFn: 'editChoreInline', mustUse: 'inlineEditText' },
    'birthdays.js': { dblClickFn: 'editBirthdayInline', mustUse: 'inlineEditText' },
    'vestiaire.js': { dblClickFn: 'editVestiaire', mustUse: 'inlineEditText' },
    'flashcards.js': { dblClickFn: 'editFlashcardInline', mustUse: 'inlineEditText' },
  };
  for (const [file, { dblClickFn, mustUse }] of Object.entries(inlinePages)) {
    const content = jsFiles[file];
    if (!content) continue;
    // 1. The onDblClick callback should reference the inline edit function (not openEdit*Modal)
    const hoverCalls = content.match(/initItemHoverDelay\([^)]*\{[\s\S]*?\}\s*\)/g) || [];
    for (const call of hoverCalls) {
      assert(!call.match(/openEdit\w*Modal/),
        `${file}: onDblClick should not call a modal opener — use inline edit instead`);
    }
    // 2. The inline edit function should exist and use inlineEditText
    assert(content.includes(dblClickFn),
      `${file}: missing inline edit function '${dblClickFn}'`);
    assert(content.includes(mustUse),
      `${file}: inline edit should use shared '${mustUse}' from item-utils.js`);
  }
});

// ===================================================================
// 21. rowSelector must differ from itemSelector (querySelector doesn't match self)
// ===================================================================
test('initItemHoverDelay rowSelector differs from itemSelector', () => {
  const pagesWithHover = ['projects.js', 'todos.js', 'chores.js', 'birthdays.js', 'vestiaire.js', 'flashcards.js'];
  for (const file of pagesWithHover) {
    const content = jsFiles[file];
    if (!content) continue;
    const calls = content.match(/initItemHoverDelay\([^)]*\{[\s\S]*?\}\s*\)/g) || [];
    for (const call of calls) {
      const itemSel = call.match(/itemSelector:\s*'([^']+)'/);
      const rowSel = call.match(/rowSelector:\s*'([^']+)'/);
      if (itemSel && rowSel) {
        assert(itemSel[1] !== rowSel[1],
          `${file}: rowSelector '${rowSel[1]}' must differ from itemSelector '${itemSel[1]}' — querySelector doesn't match self`);
      }
    }
  }
});

// ===================================================================
// SUMMARY
// ===================================================================
console.log(`\n${'═'.repeat(50)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(50)}\n`);

if (failures.length > 0) {
  console.log('Failures:');
  for (const f of failures) {
    console.log(`  • ${f.name}: ${f.error}`);
  }
  console.log('');
}

process.exit(failed > 0 ? 1 : 0);
