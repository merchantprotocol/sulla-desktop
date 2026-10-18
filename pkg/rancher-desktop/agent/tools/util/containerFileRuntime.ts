import { runCommand } from './CommandRunner';
import { currentAgentContainerRuntime } from '../../services/AgentContainerRuntimeRegistry';

interface ContainerPathInfo {
  path:        string;
  kind:        'file' | 'directory';
  entries?:    string[];
  content?:    string;
  totalLines?: number;
}

const READ_SCRIPT = String.raw`
const fs=require('fs'),path=require('path'),os=require('os');
let input='';process.stdin.on('data',c=>input+=c).on('end',()=>{try{
 const a=JSON.parse(input),raw=String(a.path||'');
 const p=path.resolve(raw==='~'?os.homedir():raw.startsWith('~/')?path.join(os.homedir(),raw.slice(2)):raw);
 const s=fs.statSync(p);
 if(s.isDirectory())return process.stdout.write(JSON.stringify({path:p,kind:'directory',entries:fs.readdirSync(p)}));
 const content=fs.readFileSync(p,'utf8');process.stdout.write(JSON.stringify({path:p,kind:'file',content,totalLines:content.split('\n').length}));
}catch(e){process.stderr.write(e.message);process.exitCode=1}});`;

const WRITE_SCRIPT = String.raw`
const fs=require('fs'),path=require('path'),os=require('os');
let input='';process.stdin.on('data',c=>input+=c).on('end',()=>{try{
 const a=JSON.parse(input),raw=String(a.path||'');if(raw==='~')throw new Error('Cannot write to home directory itself');
 const p=path.resolve(raw.startsWith('~/')?path.join(os.homedir(),raw.slice(2)):raw),roots=[path.resolve(os.homedir()),path.resolve(process.cwd())];
 if(!roots.some(r=>p===r||p.startsWith(r+path.sep)))throw new Error('Write operations are restricted to the container home or workspace');
 fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,String(a.content??''),'utf8');
 process.stdout.write(JSON.stringify({path:p,lines:String(a.content??'').split('\n').length}));
}catch(e){process.stderr.write(e.message);process.exitCode=1}});`;

const SEARCH_SCRIPT = String.raw`
const fs=require('fs'),path=require('path'),os=require('os');
let input='';process.stdin.on('data',c=>input+=c).on('end',()=>{try{
 const a=JSON.parse(input),query=String(a.query||'').toLowerCase(),limit=Math.max(1,Math.min(200,Number(a.limit)||20));
 const expand=p=>path.resolve(p==='~'?os.homedir():p.startsWith('~/')?path.join(os.homedir(),p.slice(2)):p);
 const roots=[{root:expand(a.dirPath||os.homedir()),docs:false}];
 if(a.includeSullaDocs!==false&&fs.existsSync('/opt/sulla-docs')&&roots[0].root!=='/opt/sulla-docs')roots.push({root:'/opt/sulla-docs',docs:true});
 const out=[];for(const source of roots){const stack=[source.root];while(stack.length&&out.filter(x=>x.docs===source.docs).length<limit){const p=stack.pop();let s;try{s=fs.statSync(p)}catch{continue}
  if(s.isDirectory()){if(path.basename(p)==='.git'||path.basename(p)==='node_modules')continue;let es=[];try{es=fs.readdirSync(p)}catch{}for(let i=es.length-1;i>=0;i--)stack.push(path.join(p,es[i]));continue}
  if(s.size>2e6)continue;let value='';try{value=fs.readFileSync(p,'utf8')}catch{continue}if(value.includes('\0'))continue;
  const lines=value.split('\n');let line=lines.findIndex(v=>v.toLowerCase().includes(query));if(line<0&&!p.toLowerCase().includes(query))continue;
  out.push({path:p,line:line>=0?line+1:undefined,preview:line>=0?lines[line].trim().slice(0,300):undefined,docs:source.docs});
 }}process.stdout.write(JSON.stringify({roots:roots.map(x=>x.root),results:out}));
}catch(e){process.stderr.write(e.message);process.exitCode=1}});`;

async function nodeOperation<T>(script: string, input: unknown): Promise<T> {
  const result = await runCommand('node', ['-e', script], {
    stdin: JSON.stringify(input), timeoutMs: 120_000, maxOutputChars: 1_000_000,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || 'Container file operation failed');
  return JSON.parse(result.stdout) as T;
}

export const hasContainerFileRuntime = (): boolean => Boolean(currentAgentContainerRuntime());
export const readContainerPath = (filePath: string): Promise<ContainerPathInfo> => nodeOperation(READ_SCRIPT, { path: filePath });
export const writeContainerPath = (filePath: string, content: string): Promise<{ path: string; lines: number }> => nodeOperation(WRITE_SCRIPT, { path: filePath, content });
export const searchContainerPaths = (input: { query: string; dirPath?: string; limit?: number; includeSullaDocs?: boolean }): Promise<{
  roots: string[]; results: { path: string; line?: number; preview?: string; docs: boolean }[];
}> => nodeOperation(SEARCH_SCRIPT, input);
