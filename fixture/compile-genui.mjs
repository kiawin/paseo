import {compilePlugin} from '../../packages/server/dist/server/server/plugins/compiler.js';
import fs from 'node:fs/promises';
const root='/tmp/paseo-plugin-genui-link-preference';
const bundles=await compilePlugin({client:root+'/index.client.tsx',server:root+'/index.server.ts'});
const result={success:true,clientBytes:Buffer.byteLength(bundles.clientBundle),serverBytes:Buffer.byteLength(bundles.serverBundle),note:'Production compiler only; no plugin installation or activation.'};
await fs.writeFile('/tmp/genui-pr-production-compile.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
