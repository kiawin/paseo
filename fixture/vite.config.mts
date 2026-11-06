import path from 'node:path';
import { fileURLToPath } from 'node:url';
import base from '../../packages/app/vitest.config.ts';
const root = path.dirname(fileURLToPath(import.meta.url));
const checkout = path.resolve(root, '../..');
const { test, ...config } = base;
export default {
  ...config,
  root,
  resolve: {
    ...config.resolve,
    alias: [
      {find: /^@react-native-async-storage\/async-storage$/, replacement: path.join(checkout, "node_modules/@react-native-async-storage/async-storage/lib/module/AsyncStorage.js")},
      {find: /^@getpaseo\/plugin\/client\/ui$/, replacement: path.join(root, 'ui.ts')},
      {find: /^@getpaseo\/plugin\/client\/react-native$/, replacement: path.join(root, 'ui.ts')},
      {find: /^@getpaseo\/plugin\/client$/, replacement: path.join(root, 'client.ts')},
      ...config.resolve.alias,
    ],
  },
  server: {host: '127.0.0.1', port: 8137, strictPort: true, fs: {allow: [checkout]}},
};
