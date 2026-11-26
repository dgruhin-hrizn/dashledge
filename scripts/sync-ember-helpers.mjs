// Refresh the self-contained Ember helpers when updating the widget from its source checkout.
import {createRequire} from 'node:module';
import {copyFile, readFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const [agentPath, widgetPath] = process.argv.slice(2);
if (!agentPath || !widgetPath) throw Error('Pass the Ember packages/agent path and the Ember widget checkout.');
const agent = resolve(agentPath), widget = resolve(widgetPath);
const require = createRequire(join(agent,'package.json'));
const esbuild = require('esbuild');
const output = fileURLToPath(new URL('../widgets/collectors/ember/',import.meta.url));
const exports = new Set(['export {parse} from "jsonc-parser";']);
for (const file of ['collector.mjs','transcripts.mjs','usage-report.mjs']) {
  const source = await readFile(join(widget,file),'utf8');
  for (const [line] of source.matchAll(/^import \{[^}]+\} from "@ember-agent\/[^"]+";/gm)) {
    exports.add(line.replace('import ', 'export '));
  }
}
await esbuild.build({
  absWorkingDir:agent, stdin:{contents:[...exports].join('\n'),resolveDir:agent},
  alias:{'@ember-agent':agent}, outfile:join(output,'shared.mjs'),
  mainFields:['module','main'], platform:'node', format:'esm', bundle:true, target:'node24', legalComments:'eof'
});
await copyFile(require.resolve('jsonc-parser/LICENSE.md'),join(output,'jsonc-parser.LICENSE'));
