// Prepare the explicit real producer and parser fixtures outside the repository.
import {setupSource} from '../src/source-context/install.js';
import {managedBinary} from '../src/source-context/config.js';
import {execFileSync} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
if(!process.argv[2])throw new Error('Supply an isolated fixture output directory');
const output=path.resolve(process.argv[2]);await mkdir(output,{recursive:true});
const source=path.join(output,'source');await setupSource(source);
const recorder=path.join(output,'recorder-016');
execFileSync(process.platform==='win32'?'npm.cmd':'npm',['install','--prefix',recorder,'--cache',path.join(output,'npm-cache'),'--ignore-scripts','--no-audit','--no-fund','agenticreplay@0.1.6'],{stdio:'inherit'});
console.log(JSON.stringify({ripwire:managedBinary(source),agenticreplay:path.join(recorder,'node_modules/.bin/agenticreplay')}));
