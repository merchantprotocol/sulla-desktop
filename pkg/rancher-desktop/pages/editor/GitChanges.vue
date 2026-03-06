<template>
  <div class="git-container" v-html="gitTreeHtml"></div>
</template>

<script lang="ts">
import { defineComponent, computed } from 'vue';

export default defineComponent({
  name: 'GitChanges',
  
  props: {
    gitChanges: {
      type: Array as () => {status: string, file: string}[],
      default: () => []
    }
  },

  setup(props) {
    const gitTreeHtml = computed(() => {
      const tree: Record<string, any> = {};
      props.gitChanges.forEach(({ file }) => {
        const parts = file.split('/');
        let current = tree;
        for (const part of parts) {
          if (!current[part]) current[part] = {};
          current = current[part];
        }
      });
      
      const render = (node: Record<string, any>, prefix = ''): string => {
        return Object.keys(node).map(key => {
          const full = prefix ? `${prefix}/${key}` : key;
          const indent = prefix.split('/').length * 12;
          return `<div class="git-change" style="padding-left: ${indent}px">${key}</div>` + (Object.keys(node[key]).length ? render(node[key], full) : '');
        }).join('');
      };
      
      return render(tree);
    });

    return {
      gitTreeHtml
    };
  }
});
</script>

<style scoped>
.git-container {
  padding: 12px;
}

.git-change {
  padding: 4px 0;
  font-size: 13px;
  color: #333;
  cursor: pointer;
}

:deep(.dark) .git-change {
  color: #ccc;
}
</style>
