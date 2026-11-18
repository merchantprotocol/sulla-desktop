/*
 * Sulla Desktop · https://sulladesktop.com
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

export type HtmlHrefKind='hash'|'relative'|'external'|'mailto'|'tel'|'unsupported';

export type HtmlInitialMode='editing'|'preview';

export class HtmlNavigation {
  static initialMode(options:{isNew?:boolean;readOnly?:boolean;canRunScripts?:boolean}):HtmlInitialMode {
    if(options.readOnly||options.canRunScripts===false)return 'preview';
    return options.isNew?'editing':'preview';
  }

  private entries:string[]=[];
  private index=-1;

  classify(href:string):HtmlHrefKind {
    const value=href.trim();
    if(value.startsWith('#'))return 'hash';
    if(/^https?:\/\//i.test(value))return 'external';
    if(/^mailto:/i.test(value))return 'mailto';
    if(/^tel:/i.test(value))return 'tel';
    if(!value||/^[a-z][a-z\d+.-]*:/i.test(value)||value.startsWith('//'))return 'unsupported';
    return 'relative';
  }

  resolve(currentPath:string,href:string):string|null {
    if(this.classify(href)!=='relative')return null;
    const [pathname]=href.split(/[?#]/,1);
    if(!pathname)return null;
    const parts=currentPath.split('/').filter(Boolean);
    parts.pop();
    for(const part of pathname.split('/')){
      if(!part||part==='.')continue;
      if(part==='..'){if(!parts.length)return null;parts.pop();continue;}
      try{parts.push(decodeURIComponent(part));}catch{return null;}
    }
    return parts.join('/')||null;
  }

  push(path:string):void {
    if(this.entries[this.index]===path)return;
    this.entries=this.entries.slice(0,this.index+1);
    this.entries.push(path);this.index=this.entries.length-1;
  }
  back():string|null {if(this.index<=0)return null;return this.entries[--this.index]||null;}
  forward():string|null {if(this.index<0||this.index>=this.entries.length-1)return null;return this.entries[++this.index]||null;}
  get canBack():boolean{return this.index>0;}
  get canForward():boolean{return this.index>=0&&this.index<this.entries.length-1;}
}
