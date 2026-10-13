import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
// Official lifecycle events, separate from test stdout (which can contain fake TAP).
export default async function* reporter(source) {
  const tests=[],suites=[];let summary,summaryCount=0;
  for await(const event of source) {
    if(event.type==='test:summary'&&event.data.file===undefined){summary=event.data;summaryCount++;}
    if(event.type==='test:pass'||event.type==='test:fail') {
      const d=event.data;
      const row={id:`${d.file}:${d.line}:${d.column}:${d.testId}:${d.name}`,file:path.relative(process.cwd(),d.file??'').split(path.sep).join('/'),name:d.name,fileOnly:d.line===1&&d.column===1&&(d.name===d.file||d.name===path.relative(process.cwd(),d.file??'')||d.name===path.basename(d.file??'')),type:event.type,skipped:!!d.skip,todo:!!d.todo};
      (d.details?.type==='suite'?suites:tests).push(row);
    }
  }
  const directory=process.env.KIOKUKO_VERIFY_REPORT_DIR;
  if(!directory)throw new Error('Verification report directory is missing');
  mkdirSync(directory,{recursive:true});
  writeFileSync(path.join(directory,`${randomUUID()}.json`),JSON.stringify({schema:'verification-node-v1',complete:!!summary&&tests.length===summary.counts.tests,summaryCount,counts:summary?.counts,tests,suites}));
}
