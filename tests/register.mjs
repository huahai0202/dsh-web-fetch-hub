import * as module from 'node:module'
import { resolve } from './loader.mjs'
if (typeof module.registerHooks === 'function') module.registerHooks({ resolve })
else module.register('./loader.mjs', import.meta.url)
