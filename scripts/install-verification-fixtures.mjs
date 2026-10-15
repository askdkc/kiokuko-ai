// Prepare the explicit real producer and parser fixtures outside the repository.
import {setupSource} from '../src/source-context/install.js';
import {managedBinary} from '../src/source-context/config.js';
import {managedAgenticReplay} from './agenticreplay-dependency.mjs';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
if(!process.argv[2])throw new Error('Supply an isolated fixture output directory');
const recorder=managedAgenticReplay();
const output=path.resolve(process.argv[2]);await mkdir(output,{recursive:true});
const source=path.join(output,'source');await setupSource(source);
console.log(JSON.stringify({ripwire:managedBinary(source),agenticreplay:recorder.binary,agenticreplayVersion:recorder.version}));
