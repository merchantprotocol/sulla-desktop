import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
export default defineConfig({root:'web-src',base:'/files/',plugins:[vue()],build:{outDir:'../web',emptyOutDir:true,sourcemap:false}});
