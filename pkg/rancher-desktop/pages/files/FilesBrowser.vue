<template>
  <div
    ref="browserSurface"
    class="files-browser"
    :class="{ dragging }"
    @dragenter.prevent="onBrowserDragEnter"
    @dragover.prevent="onBrowserDragOver"
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
    <nav
      class="nav"
      aria-label="Files sections"
    >
      <div class="brand">
        <div class="mark">
          S
        </div><div><b>Sulla</b><span>{{ brandLine }}</span></div>
      </div>
      <div v-if="visibleCollections.length" class="tree-roots" aria-label="Pinned file tree roots">
        <div class="grp">Folders</div>
        <button v-for="collection in visibleCollections" :key="collection.id" type="button"
          :class="{ on: collection.id === snapshot?.collection.id }" :disabled="busy || loading"
          @click="selectCollection(collection.id)"><span class="sv" v-html="icons.folderLine" /><span>{{ collection.name }}</span></button>
      </div>
      <div v-if="dragTargets.length && dragSourceCapability !== 'unavailable' && (snapshot?.availableCollections?.length ?? 0) > 1" class="collection-drops" aria-label="Move selection to collection">
        <button v-for="collection in otherCollections" :key="collection.id" class="btn sm" type="button" @dragover.prevent.stop="setCollectionDropEffect" @drop.prevent.stop="onCollectionDrop(collection.id, $event)">Move to {{ collection.name }}</button>
      </div>
      <a
        v-for="entry in sections"
        :key="entry.id"
        href="#"
        :class="{ on: section === entry.id }"
        @dragover.prevent="entry.id === 'files' && onNavigationDragOver('', $event)"
        @drop.prevent="entry.id === 'files' && onNavigationDrop('', $event)"
        @click.prevent="selectSection(entry.id)"
      ><span
        class="sv"
        v-html="entry.icon"
      /><span>{{ entry.label }}</span><span
        v-if="entry.count"
        class="cnt"
        :class="{ warn: entry.warn }"
      >{{ entry.count }}</span></a>
      <template v-if="sharedFolders.length">
        <div class="grp">
          Shared folders
        </div>
        <a
          v-for="folder in sharedFolders"
          :key="folder"
          href="#"
          :class="{ on: section === 'files' && currentPath === folder }"
          @dragover.prevent="onNavigationDragOver(folder, $event)"
          @drop.prevent="onNavigationDrop(folder, $event)"
          @click.prevent="openPath(folder)"
        ><span
          class="sv"
          v-html="icons.folderLine"
        /><span>{{ folder.split('/').at(-1) }}</span></a>
      </template>

      <div class="sep" />
      <section
        class="favorites"
        :class="{ 'drop-target': favoriteDropActive }"
        aria-label="Favorite folders"
        @dragenter="onFavoriteDragEnter"
        @dragover="onFavoriteDragOver"
        @dragleave="onFavoriteDragLeave"
        @drop="onFavoriteDrop"
      >
        <div class="grp favorites-heading">
          Favorites <span>Drop folders here</span>
        </div>
        <div
          v-for="folder in folderFavorites"
          :key="folder.path"
          class="favorite-row"
          :class="{ unavailable: !folder.available }"
        >
          <button
            class="favorite-link"
            type="button"
            :class="{ on: section === 'files' && currentPath === folder.path }"
            :disabled="busy || loading || !folder.available"
            :title="folder.available ? folder.path : `${folder.path} is unavailable`"
            @click="openPath(folder.path)"
          ><span
            class="sv"
            v-html="icons.folderLine"
          /><span>{{ folder.name }}</span><small v-if="!folder.available">Unavailable</small></button>
          <button
            class="favorite-remove"
            type="button"
            :disabled="busy || loading"
            :aria-label="`Remove ${folder.path} from Favorites`"
            title="Remove from Favorites"
            @click="setFolderFavorite(folder.path, false)"
          >×</button>
        </div>
      </section>
      <div
        class="quota"
        :class="{ nobar: !quotaBytes }"
      >
        <b>{{ formatBytes(totalBytes) }}</b><template v-if="quotaBytes">
          of {{ formatBytes(quotaBytes) }}
        </template> {{ storageWhere }}<div
          v-if="quotaBytes"
          class="bar"
        >
          <i :style="{ width: `${storagePercent}%` }" />
        </div><span>{{ activeFiles.length.toLocaleString() }} file{{ activeFiles.length === 1 ? '' : 's' }}<template v-if="snapshot?.collection.keptBytes !== undefined"> · {{ formatBytes(snapshot.collection.keptBytes) }} kept on this Mac</template></span>
      </div>
      <button
        v-if="dataSource.capabilities.nativeFilesystem"
        class="syncline"
        type="button"
        :title="syncTooltip"
        @click="togglePause"
      >
        <span
          class="dot"
          :class="syncState"
        />{{ syncLine }}
      </button>
      <div v-else class="syncline" :title="syncTooltip">
        <span class="dot" :class="syncState" />{{ syncLine }}
      </div>
      <div class="foot">
        <div class="avatar">
          {{ initials(accountName) }}
        </div><div><b>{{ accountName }}</b><small>{{ accountLine }}</small></div>
      </div>
    </nav>

    <main
      v-if="!selected"
      ref="mainSurface"
      class="main"
      tabindex="-1"
      @auxclick="onMouseNavigation"
      @contextmenu.self.prevent="openBackgroundActions"
    >
      <div class="top">
        <div class="crumbs">
          <template v-if="crumbs.length">
            <a
              class="c"
              href="#"
              data-drop-path=""
              @dragover.prevent="onNavigationDragOver('', $event)"
              @drop.prevent="onNavigationDrop('', $event)"
              @click.prevent="openRoot"
            >{{ rootLabel }}</a>
            <template
              v-for="(crumb, index) in crumbs"
              :key="crumb.path"
            >
              <span>›</span><b v-if="index === crumbs.length - 1">{{ crumb.label }}</b><a
                v-else
                class="c"
                href="#"
                :data-drop-path="crumb.path"
                @dragover.prevent="onNavigationDragOver(crumb.path, $event)"
                @drop.prevent="onNavigationDrop(crumb.path, $event)"
                @click.prevent="openPath(crumb.path)"
              >{{ crumb.label }}</a>
            </template>
          </template>
          <b v-else>{{ rootLabel }}</b>
        </div>
        <label v-if="section !== 'sharedByMe'" class="search"><span
          class="si"
          v-html="icons.search"
        /><input
          ref="searchInput"
          v-model="query"
          placeholder="Search files, folders, transcripts and screenshot text"
        ><kbd>⌘K</kbd></label>
        <div v-if="section !== 'sharedByMe'" class="acts">
          <button
            v-if="!readOnlyArea && (dataSource.capabilities.upload || dataSource.capabilities.durableOperations)"
            class="btn"
            type="button"
            :disabled="busy || loading || section !== 'files' || readOnlyArea"
            @click="newFolder"
          >
            <span
              class="bi"
              v-html="icons.plus"
            /> New folder
          </button>
          <button
            v-if="!readOnlyArea && dataSource.createFile"
            class="btn"
            type="button"
            :disabled="busy || loading || section !== 'files' || readOnlyArea"
            @click="newFile"
          >New file</button>
          <button
            v-if="!readOnlyArea && dataSource.nativeSourceReady && dataSource.chooseNativeSource"
            class="btn"
            type="button"
            :disabled="busy"
            @click="chooseNativeSource"
          >Add native file</button>
          <button
            class="btn pri"
            type="button"
            :disabled="busy || readOnlyArea || !dataSource.capabilities.upload"
            @click="upload"
          >
            <span
              class="bi"
              v-html="icons.upload"
            /> Upload
          </button>
        </div>
      </div>

      <div v-if="section === 'sharedByMe'" class="content">
        <SharedByMe :data-source="dataSource" />
      </div>
      <div v-else class="content" @contextmenu="onSurfaceContextMenu" @click.self="clearSelection">
        <div class="toolbar">
          <div v-if="section === 'files' && !readOnlyArea" class="history-controls">
            <button
              class="folder-up"
              type="button"
              aria-label="Back"
              title="Back"
              :disabled="busy || loading || !canGoBack"
              @click="goBack"
            ><span v-html="icons.arrowLeft" /></button>
            <button
              class="folder-up forward"
              type="button"
              aria-label="Forward"
              title="Forward"
              :disabled="busy || loading || !canGoForward"
              @click="goForward"
            ><span v-html="icons.arrowLeft" /></button>
          <button
            v-if="currentPath"
            class="folder-up"
            type="button"
            :aria-label="`Back to ${parentFolderLabel}`"
            :title="`Back to ${parentFolderLabel}`"
            :disabled="busy || loading"
            :data-drop-path="parentPath"
            @dragover.prevent="onNavigationDragOver(parentPath, $event)"
            @drop.prevent="onNavigationDrop(parentPath, $event)"
            @click="openParent"
          >
            <span v-html="icons.arrowLeft" />
          </button><h1>{{ pageTitle }}</h1><span class="meta">{{ summaryText }}</span>
          </div><h1 v-else>{{ pageTitle }}</h1><span v-if="section !== 'files'" class="meta">{{ summaryText }}</span>
          <div class="right">
            <select
              v-if="snapshot?.availableCollections?.length"
              :value="snapshot.collection.id"
              aria-label="Browse collection"
              :disabled="busy || loading"
              @change="selectCollection(($event.target as HTMLSelectElement).value)"
            ><option v-for="collection in snapshot.availableCollections" :key="collection.id" :value="collection.id">{{ collection.name }}</option></select>
            <button
              v-if="snapshot?.collection.id"
              class="btn sm ghost"
              type="button"
              :aria-pressed="currentCollectionPinned"
              :title="currentCollectionPinned ? 'Remove this collection from the sidebar' : 'Pin this collection to the sidebar'"
              @click="setCollectionPinned(snapshot.collection.id, !currentCollectionPinned)"
            >{{ currentCollectionPinned ? 'Unpin from sidebar' : 'Pin to sidebar' }}</button>
            <button
              v-if="snapshot?.collection.memberCount !== undefined"
              class="btn sm ghost"
              type="button"
              :disabled="!dataSource.capabilities.orgSharing"
              title="Share this folder with an organization member"
              @click="shareCurrentFolder"
            >
              <span
                class="bi"
                v-html="icons.users"
              /> Shared with {{ snapshot.collection.memberCount }}
            </button>
            <button
              class="btn sm"
              type="button"
              :disabled="!dataSource.capabilities.publicLinks || !selectedFileForShare"
              title="Copy a public Sulla Cloud link for the selected file"
              @click="shareSelectedFile"
            >
              <span
                class="bi"
                v-html="icons.share"
              /> Share
            </button>
          </div>
        </div>
        <div v-if="snapshot?.status.indexing" class="operation-error" :class="{ 'index-complete': snapshot.status.indexing.complete }">
          Index: {{ indexSummary }}
        </div>
        <div v-if="query.trim() && searchCoverage && !searchCoverage.complete" class="operation-error" role="status">
          Search coverage is incomplete: {{ searchCoverage.pending + searchCoverage.indexing }} file{{ searchCoverage.pending + searchCoverage.indexing === 1 ? '' : 's' }} still processing, {{ searchCoverage.partial }} partially indexed, {{ searchCoverage.unsupported }} unsupported, and {{ searchCoverage.failed }} failed. Partial files can still match within the extracted portion; unsupported and failed files cannot contribute content matches.
        </div>
        <div v-for="source in nativeSources.filter(item => item.state !== 'active')" :key="source.fileId" class="operation-error" role="status">
          {{ source.name }} needs native access restored. {{ source.lastError || '' }}
          <button class="btn sm" type="button" :disabled="busy || !dataSource.recoverNativeSource" @click="recoverNativeSource(source.fileId)">Reselect file</button>
        </div>

        <div class="filters">
          <label
            v-for="filter in filters"
            :key="filter.key"
            class="sel"
            :class="{ active: activeFilters[filter.key] }"
          ><span>{{ filter.label }}</span> {{ activeFilters[filter.key] || filter.any }}<select
            v-model="activeFilters[filter.key]"
            :aria-label="filter.label"
          ><option value="">{{ filter.any }}</option><option
            v-for="option in filter.options"
            :key="option"
            :value="option"
          >{{ option }}</option></select></label>
          <button
            class="clear"
            type="button"
            @click="clearFilters"
          >
            Clear
          </button>
          <span
            v-if="section === 'trash'"
            class="pill idle"
          >{{ retentionLabel }}</span>
          <button v-if="section === 'trash'" class="btn sm danger" type="button" :disabled="busy || !canEmptyTrash || !trashItems.length" @click="emptyTrash">Empty Trash</button>
          <div class="view">
            <label class="sel"><span>Sort</span> {{ sortLabel }}<select
              v-model="sort"
              aria-label="Sort"
              @change="saveFolderPreferences"
            ><option value="name">Name</option><option value="modified">Modified</option><option value="size">Size</option><option value="type">Type</option></select></label>
            <div
              class="seg"
              role="group"
              aria-label="View"
            >
              <button
                type="button"
                :class="{ on: view === 'list' }"
                @click="view = 'list'"
              >
                <span
                  class="bi"
                  v-html="icons.list"
                /> List
              </button><button
                type="button"
                :class="{ on: view === 'grid' }"
                @click="view = 'grid'"
              >
                <span
                  class="bi"
                  v-html="icons.grid"
                /> Grid
              </button>
            </div>
          </div>
        </div>

        <div class="selection-slot" :aria-hidden="!selectedEntries.length"><div v-show="selectedEntries.length" class="selection-bar">
          <b>{{ selectedEntries.length }} selected</b>
          <template v-if="section !== 'trash' && !readOnlyArea">
            <button class="btn sm" type="button" :disabled="busy || selectedEntries.length !== 1" @click="renameSelected">Rename</button>
            <button class="btn sm" type="button" :disabled="busy" @click="moveSelected">Move</button>
            <button class="btn sm" type="button" :disabled="busy" @click="copyToClipboard('copy')">Copy</button>
            <button class="btn sm" type="button" :disabled="busy" @click="copyToClipboard('cut')">Cut</button>
            <button class="btn sm" type="button" :disabled="busy || !canPaste" @click="pasteClipboard">Paste</button>
          </template>
          <button class="btn sm" type="button" :disabled="busy || selectedEntries.every(entry => entry.folder)" @click="downloadSelected">Download</button>
          <template v-if="section === 'trash'"><button class="btn sm" type="button" :disabled="busy || !dataSource.restoreTrashItem" @click="restoreSelected">Restore</button><button class="btn sm danger" type="button" :disabled="busy || !dataSource.purgeTrashItem" @click="purgeSelected">Delete permanently</button></template><button v-else class="btn sm danger" type="button" :disabled="busy" @click="trashSelected">Move to Trash</button>
        </div>
        </div>
        <div v-if="operationError" class="operation-error" role="alert">
          {{ operationError }} <button class="btn sm ghost" type="button" @click="operationError = ''">Dismiss</button>
        </div>
        <div v-if="crossCollectionClipboardMessage" class="operation-panel" role="status">{{ crossCollectionClipboardMessage }}</div>
        <div v-if="operationNotice" class="operation-panel" role="status">{{ operationNotice }}</div>
        <div v-if="queueError" class="operation-error" role="alert">{{ queueError }} <button class="btn sm" :disabled="busy" @click="recoverOperation">Check operation</button></div>
        <div v-if="operationReceipt" class="operation-panel operation-queue" aria-label="File operations">
          <div>
            <label>Recent operations <select :value="operationReceipt.operationId" :disabled="busy" @change="showOperation(($event.target as HTMLSelectElement).value)"><option v-for="receipt in operationHistory" :key="receipt.operationId" :value="receipt.operationId">{{ receipt.items[0]?.action }} · {{ receipt.items.length }} items · {{ receipt.state }}</option></select></label>
            <b>Operation {{ operationReceipt.state }}</b>
            <span>{{ operationReceipt.items.filter(item => item.state === 'completed').length }} completed · {{ operationReceipt.items.filter(item => item.state === 'skipped').length }} skipped · {{ operationReceipt.items.filter(item => item.state === 'failed').length }} failed</span>
            <progress :value="operationReceipt.items.filter(item => item.state !== 'pending').length" :max="operationReceipt.items.length" aria-label="Items resolved" />
            <ul><li v-for="item in operationReceipt.items" :key="item.itemId">
              <span>{{ item.after?.path || item.before?.path || item.action }} — {{ item.state }}<template v-if="item.error">: {{ item.error.message }}</template></span>
              <button v-if="item.retryable && item.error?.code !== 'destination-conflict' && dataSource.retryOperation" class="btn sm" :disabled="busy" @click="retryReceipt(item.itemId)">Retry item</button>
            </li></ul>
          </div>
          <button v-if="operationReceipt.state === 'pending' && dataSource.cancelOperation" class="btn sm" :disabled="operationReceipt.cancelRequested" @click="operations.cancel(operationReceipt.operationId)">{{ operationReceipt.cancelRequested ? 'Cancellation requested' : 'Cancel remaining' }}</button>
          <button v-if="operationReceipt.retryable && dataSource.retryOperation" class="btn sm" :disabled="busy" @click="retryReceipt()">Retry remaining</button>
          <button v-if="undoReceipt && dataSource.undoOperation" class="btn sm" :disabled="!canUndo" @click="undoLastOperation">Undo</button>
        </div>
        <div v-if="collisionItem && dataSource.retryOperation" class="operation-panel collision-panel" role="dialog" aria-label="File name conflict">
          <div><b>A destination already exists</b><span>{{ collisionItem.error?.destination?.path || collisionItem.error?.message }}</span></div>
          <label><input v-model="applyCollisionToAll" type="checkbox">Apply to all current conflicts</label>
          <button class="btn sm" :disabled="busy" @click="resolveCollision('keep-both')">Keep Both</button>
          <button class="btn sm" :disabled="busy" @click="resolveCollision('skip')">Skip</button>
          <button class="btn sm danger" :disabled="busy || !canReplaceCollision" @click="resolveCollision('replace')">Replace</button>
        </div>
        <div v-if="busy && !operationReceipt" class="operation-panel" role="status">Working…</div>

        <div
          v-if="loading"
          class="state-panel"
        >
          <span class="loader" /><strong>Loading your files</strong><p>Reading the synced index from the Files service.</p>
        </div>
        <div
          v-else-if="error"
          class="state-panel error-state"
        >
          <span
            class="state-icon"
            v-html="icons.alert"
          /><strong>Files service isn’t available</strong>
          <p>{{ error }}</p><div>
            <button
              class="btn pri"
              type="button"
              @click="refresh()"
            >
              Try again
            </button><button
              v-if="dataSource.capabilities.upload"
              class="btn"
              type="button"
              @click="upload"
            >
              Choose files
            </button>
          </div>
        </div>
        <div
          v-else-if="visibleEntries.length === 0"
          class="state-panel"
          @click.self="clearSelection"
        >
          <span
            class="state-icon"
            v-html="section === 'trash' ? icons.trash : icons.folderLine"
          />
          <strong>{{ emptyTitle }}</strong><p>{{ emptyCopy }}</p>
          <button
            v-if="section === 'files' && !readOnlyArea"
            class="btn pri"
            type="button"
            @click="upload"
          >
            Choose files
          </button>
        </div>

        <div
          v-else-if="view === 'list'"
          ref="listSurface"
          class="card files"
          @pointerdown="startMarquee"
          @click.self="clearSelection"
          @contextmenu.self.prevent="openBackgroundActions"
          @dragover="onSurfaceDragOver"
        >
          <table class="tbl">
            <thead>
              <tr>
                <th style="width:36px">
                  <button
                    class="chk"
                    :class="{ on: allVisibleSelected }"
                    type="button"
                    role="checkbox"
                    :aria-checked="allVisibleSelected"
                    aria-label="Select all"
                    @click="toggleAll"
                  />
                </th>
                <th :style="columnStyle('name')" @click="setSort('name')">Name <span class="sort-arrow">{{ sortIndicator('name') }}</span><i class="resize-handle" @pointerdown.stop.prevent="startColumnResize('name', $event)" /></th><th class="col-owner" :style="columnStyle('owner')">
                  Owner
                  <i class="resize-handle" @pointerdown.stop.prevent="startColumnResize('owner', $event)" />
                </th><th :style="columnStyle('modified')" @click="setSort('modified')">Modified <span class="sort-arrow">{{ sortIndicator('modified') }}</span><i class="resize-handle" @pointerdown.stop.prevent="startColumnResize('modified', $event)" /></th><th class="r col-size" :style="columnStyle('size')" @click="setSort('size')">
                  Size
                  <span class="sort-arrow">{{ sortIndicator('size') }}</span><i class="resize-handle" @pointerdown.stop.prevent="startColumnResize('size', $event)" />
                </th><th style="width:44px;text-align:center">
                  Sync
                </th><th style="width:150px" />
              </tr>
            </thead>
            <tbody>
              <template
                v-for="group in groups"
                :key="group.label"
              >
                <tr class="sechead">
                  <td colspan="7">
                    {{ group.label }}
                  </td>
                </tr>
                <tr
                  v-for="entry in group.entries"
                  :key="entry.key"
                  class="row"
                  :class="{ 'is-sel': selectedKeys.has(entry.key), 'is-cut': isCut(entry), 'is-dragging': draggedKeys.has(entry.key), 'drop-target': dropTargetKey === entry.key, agent: entry.agent }"
                  :draggable="section === 'files' && !readOnlyArea && !busy && editingKey !== entry.key"
                  :data-entry-key="entry.key"
                  @pointerdown="prepareDragSnapshot(entry)"
                  @click="focusEntry(entry, $event)"
                  @dblclick="activate(entry)"
                  @contextmenu.prevent.stop="openActions(entry, $event)"
                  @dragstart="onEntryDragStart(entry, $event)"
                  @dragenter="onFolderDragEnter(entry, $event)"
                  @dragover="onFolderDragOver(entry, $event)"
                  @dragleave="onFolderDragLeave(entry, $event)"
                  @drop="onFolderDrop(entry, $event)"
                  @dragend="clearInternalDrag"
                  tabindex="0"
                  :aria-selected="selectedKeys.has(entry.key)"
                  @keydown="onEntryKeydown(entry, $event)"
                >
                  <td>
                    <button
                      class="chk"
                      :class="{ on: selectedKeys.has(entry.key) }"
                      type="button"
                      role="checkbox"
                      :aria-checked="selectedKeys.has(entry.key)"
                      :aria-label="`Select ${entry.name}`"
                      @click.stop="toggleSelected(entry.key)"
                      @dblclick.stop
                    />
                  </td>
                  <td>
                    <div class="name">
                      <span
                        class="fi"
                        :class="entry.kindClass"
                        v-html="entry.icon"
                      /><div class="t">
                        <input
                          v-if="editingKey === entry.key"
                          :ref="element => setRenameInput(element, entry)"
                          v-model="renameValue"
                          class="inline-rename"
                          aria-label="Rename item"
                          @click.stop
                          @dblclick.stop
                          @keydown.enter.prevent="commitRename(entry)"
                          @keydown.escape.prevent="cancelRename"
                          @blur="commitRename(entry)"
                        ><b v-else>{{ entry.name }}</b><small>{{ entry.subtitle }}</small>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div class="own">
                      <img
                        v-if="entry.ownerAvatarUrl"
                        class="avatar sm"
                        :src="entry.ownerAvatarUrl"
                        alt=""
                      ><span
                        v-else
                        class="avatar sm"
                        :class="avatarClass(entry)"
                      >{{ ownerInitials(entry) }}</span><span class="nm">{{ ownerName(entry) }}</span>
                    </div>
                  </td>
                  <td class="muted">
                    {{ formatRelative(entry.updatedAt) }}
                  </td>
                  <td class="r muted col-size">
                    {{ formatBytes(entry.size) }}
                  </td>
                  <td style="text-align:center">
                    <span
                      class="sync"
                      :class="syncClass(entry)"
                      :title="syncText(entry)"
                      v-html="syncIcon(entry)"
                    />
                  </td>
                  <td @dblclick.stop>
                    <button v-if="section !== 'trash' || !entry.folder" class="btn sm details-action" type="button" @click.stop="showDetails(entry)">Details</button>
                    <button v-if="!entry.folder && ['failed', 'unsupported'].includes(entry.indexStatus)" class="btn sm" type="button" :disabled="busy" :title="entry.indexReason" @click.stop="reindex(entry)">Re-index</button>
                    <div
                      v-if="entrySync(entry) === 'conflict' && !entry.folder"
                      class="actions keep"
                    >
                      <button
                        class="btn sm danger"
                        type="button"
                        :disabled="busy || !props.dataSource.keepConflictCopies || !entry.conflictSourceFileId || !entry.conflictSourceVersionId"
                        title="Keep both preserved files and clear this conflict warning"
                        @click.stop="keepBothConflict(entry)"
                      >
                        Keep both
                      </button><button
                        class="btn ico"
                        type="button"
                        title="More"
                        @click.stop="openActions(entry, $event)"
                        v-html="icons.more"
                      />
                    </div>
                    <div
                      v-else
                      class="actions"
                    >
                      <button
                        v-if="section !== 'trash'"
                        class="btn ico"
                        type="button"
                        :disabled="!dataSource.capabilities.publicLinks || entry.folder"
                        title="Copy public link"
                        @click.stop="shareEntry(entry)"
                        v-html="icons.share"
                      /><button
                        v-if="section !== 'trash' && !readOnlyArea"
                        class="btn ico"
                        type="button"
                        :title="starred.has(entry.id) ? 'Unstar' : 'Star'"
                        @click.stop="toggleStar(entry.id)"
                        v-html="starred.has(entry.id) ? icons.starOn : icons.star"
                      /><button
                        class="btn ico"
                        type="button"
                        title="More"
                        @click.stop="openActions(entry, $event)"
                        v-html="icons.more"
                      />
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>

        <div
          v-else
          ref="gridSurface"
          class="gridv"
          @pointerdown="startMarquee"
          @click.self="clearSelection"
          @contextmenu.self.prevent="openBackgroundActions"
          @dragover="onSurfaceDragOver"
        >
          <div
            v-for="entry in visibleEntries"
            :key="entry.key"
            class="tile"
            :class="{ 'is-sel': selectedKeys.has(entry.key), 'is-cut': isCut(entry), 'is-dragging': draggedKeys.has(entry.key), 'drop-target': dropTargetKey === entry.key }"
            :draggable="section === 'files' && !readOnlyArea && !busy && editingKey !== entry.key"
            :data-entry-key="entry.key"
            @pointerdown="prepareDragSnapshot(entry)"
            @click="focusEntry(entry, $event)"
            @dblclick="activate(entry)"
            @contextmenu.prevent.stop="openActions(entry, $event)"
            @dragstart="onEntryDragStart(entry, $event)"
            @dragenter="onFolderDragEnter(entry, $event)"
            @dragover="onFolderDragOver(entry, $event)"
            @dragleave="onFolderDragLeave(entry, $event)"
            @drop="onFolderDrop(entry, $event)"
            @dragend="clearInternalDrag"
                  tabindex="0"
                  :aria-selected="selectedKeys.has(entry.key)"
                  @keydown="onEntryKeydown(entry, $event)"
          >
            <div
              class="th"
              :class="{ folderth: entry.folder && !entry.agent, agentth: entry.agent }"
            >
              <span
                class="fi"
                :class="entry.kindClass"
                v-html="entry.icon"
              /><span
                class="sync"
                :class="syncClass(entry)"
                v-html="syncIcon(entry)"
              />
            </div>
            <button v-if="section !== 'trash' || !entry.folder" class="btn sm details-action" type="button" @click.stop="showDetails(entry)" @dblclick.stop>Details</button>
            <div class="bd">
              <input
                v-if="editingKey === entry.key"
                :ref="element => setRenameInput(element, entry)"
                v-model="renameValue"
                class="inline-rename"
                aria-label="Rename item"
                @click.stop
                @dblclick.stop
                @keydown.enter.prevent="commitRename(entry)"
                @keydown.escape.prevent="cancelRename"
                @blur="commitRename(entry)"
              ><b v-else>{{ entry.name }}</b><small>{{ entry.folder ? `${entry.childCount} file${entry.childCount === 1 ? '' : 's'}` : formatBytes(entry.size) }} · {{ formatShort(entry.updatedAt) }}</small>
            </div>
          </div>
        </div>
        <Teleport to="body">
          <div v-if="actionTarget" ref="actionMenu" class="action-menu" role="menu" :aria-label="`Actions for ${actionTarget.name}`" :style="{ left: `${menuPosition.x}px`, top: `${menuPosition.y}px` }" @keydown="onMenuKeydown" @contextmenu.prevent @click.stop @dblclick.stop>
            <b>{{ actionTarget.name }}</b>
            <button v-if="section !== 'trash' && actionTarget.folder" role="menuitem" type="button" @click="runTargetAction('open')">Open folder</button>
            <button v-else-if="section !== 'trash'" role="menuitem" type="button" @click="runTargetAction('native-open')">Open</button>
            <button v-if="section !== 'trash' && !actionTarget.folder && dataSource.capabilities.nativeReveal && dataSource.revealFile" role="menuitem" type="button" @click="runTargetAction('reveal')">Reveal in folder</button>
            <button v-if="section !== 'trash' && !actionTarget.folder" role="menuitem" type="button" @click="runTargetAction('reference')">Copy file reference</button>
            <button v-if="section !== 'trash' || !actionTarget.folder" role="menuitem" type="button" @click="runTargetAction('details')">Details</button>
            <button v-if="section !== 'trash' && canShareEntry(actionTarget)" role="menuitem" type="button" @click="runTargetAction('share')">Share</button>
            <template v-if="section !== 'trash' && !readOnlyArea">
              <button role="menuitem" type="button" :disabled="busy" @click="runTargetAction('rename')">Rename</button>
              <button role="menuitem" type="button" :disabled="busy" @click="runTargetAction('move')">Move</button>
              <button role="menuitem" type="button" :disabled="busy" @click="runTargetAction('copy')">Copy</button>
              <button role="menuitem" type="button" :disabled="busy" @click="runTargetAction('cut')">Cut</button>
              <button v-if="!actionTarget.folder" role="menuitem" type="button" :disabled="busy" @click="runTargetAction('download')">Download</button>
              <button v-if="!actionTarget.folder && dataSource.capabilities.onlineOnly && (entrySync(actionTarget) === 'online-only' ? dataSource.keepOnMac : dataSource.makeOnlineOnly)" role="menuitem" type="button" :disabled="busy" @click="runTargetAction(entrySync(actionTarget) === 'online-only' ? 'keep-local' : 'online-only')">{{ entrySync(actionTarget) === 'online-only' ? 'Keep on this computer' : 'Make online only' }}</button>
              <button v-if="dataSource.capabilities.trash" role="menuitem" type="button" class="danger" :disabled="busy" @click="runTargetAction('trash')">Move to Trash</button>
            </template>
            <template v-else>
              <button role="menuitem" type="button" :disabled="busy || !dataSource.restoreTrashItem" @click="runTargetAction('restore')">Restore</button>
              <button role="menuitem" type="button" class="danger" :disabled="busy || !dataSource.purgeTrashItem" @click="runTargetAction('purge')">Delete permanently</button>
            </template>
          </div>
        </Teleport>
        <Teleport to="body">
          <div v-if="backgroundMenu" ref="backgroundActionMenu" class="action-menu" role="menu" aria-label="Folder actions" :style="{ left: `${backgroundMenu.x}px`, top: `${backgroundMenu.y}px` }" @keydown="onMenuKeydown" @click.stop @contextmenu.prevent>
            <b>{{ pageTitle }}</b>
            <button role="menuitem" type="button" :disabled="!canPaste || busy" @click="pasteClipboard(); closeBackgroundActions()">Paste</button>
            <button role="menuitem" type="button" :disabled="busy || section !== 'files'" @click="newFolder(); closeBackgroundActions()">New folder</button>
            <button v-if="!readOnlyArea && dataSource.createFile" role="menuitem" type="button" :disabled="busy || section !== 'files'" @click="newFile(); closeBackgroundActions()">New file</button>
            <button role="menuitem" type="button" @click="setSort('name'); closeBackgroundActions()">Sort by name</button>
            <button role="menuitem" type="button" @click="refresh(true); closeBackgroundActions()">Refresh</button>
          </div>
        </Teleport>

        <div
          v-if="!loading && !error && section === 'files'"
          class="drop"
        >
          <span
            class="ico"
            v-html="icons.upload"
          /><div><b>{{ uploadHeading }}</b><small>{{ dropCopy }}</small></div><button
            class="btn"
            type="button"
            :disabled="busy || readOnlyArea || !dataSource.capabilities.upload"
            @click="upload"
          >
            Choose files
          </button>
        </div>
      </div>
    </main>

    <FileDetail
      v-else-if="snapshot"
      :key="`${selected.id}:${selected.currentVersionId}`"
      :item="selected"
      :trash-item="selected.trashItem?.kind === 'file' ? selected.trashItem : undefined"
      :collection="snapshot.collection"
      :data-source="dataSource"
      :initial-tab="detailTab === 'versions' ? 'Versions' : 'Details'"
      @close="selected = null"
      @share="shareEntry(selected)"
      @restored="selected = null; refresh(true)"
      @trash-outcome="onTrashDetailOutcome"
      @open-linked="openLinked"
    />

    <div
      v-if="dragging && dataSource.capabilities.upload"
      class="drop-overlay"
    >
      <span v-html="icons.upload" /><strong>Drop files here to upload to {{ pageTitle }}</strong><p>{{ dropCopy }}</p>
    </div>
    <Teleport to="body">
      <div v-if="quickLookEntry" ref="quickLookDialog" class="quick-look" role="dialog" aria-modal="true" :aria-label="`Quick Look: ${quickLookEntry.name}`" @click.self="closeQuickLook">
        <button class="quick-look-close" type="button" aria-label="Close Quick Look" @click="closeQuickLook" v-html="icons.close" />
        <button class="quick-look-nav previous" type="button" aria-label="Previous item" :disabled="quickLookIndex <= 0" @click="stepQuickLook(-1)">‹</button>
        <div class="quick-look-card">
          <div v-if="quickLookLoading" class="state-panel"><span class="loader" /><strong>Loading preview</strong></div>
          <img v-else-if="quickLookUrl && quickLookEntry.mime.startsWith('image/')" :src="quickLookUrl" :alt="quickLookEntry.name">
          <video v-else-if="quickLookUrl && quickLookEntry.mime.startsWith('video/')" :src="quickLookUrl" controls autoplay />
          <audio v-else-if="quickLookUrl && quickLookEntry.mime.startsWith('audio/')" :src="quickLookUrl" controls autoplay />
          <iframe v-else-if="quickLookUrl && quickLookEntry.mime === 'application/pdf'" :src="quickLookUrl" :title="quickLookEntry.name" sandbox="" />
          <div v-else class="quick-look-fallback"><span class="fi" :class="quickLookEntry.kindClass" v-html="quickLookEntry.icon" /><p>Preview isn’t available for this item.</p></div>
          <footer><b>{{ quickLookEntry.name }}</b><span>{{ formatBytes(quickLookEntry.size) }} · {{ formatDate(quickLookEntry.updatedAt, true) }}</span></footer>
        </div>
        <button class="quick-look-nav next" type="button" aria-label="Next item" :disabled="quickLookIndex >= quickLookEntries.length - 1" @click="stepQuickLook(1)">›</button>
      </div>
    </Teleport>
    <div v-if="marquee" class="marquee" :style="marqueeStyle" />
    <div v-if="draggedKeys.size > 1" class="drag-count" :style="{ left: `${dragPointer.x + 14}px`, top: `${dragPointer.y + 14}px` }">{{ draggedKeys.size }}</div>
    <div
      v-if="uploadProgress"
      class="upl"
    >
      <div class="hd">
        {{ uploadProgress.done ? 'Upload complete' : `Uploading ${uploadProgress.current} of ${uploadProgress.total}` }}<button
          class="btn ico"
          type="button"
          aria-label="Hide upload progress"
          @click="uploadProgress = null; uploadLog = []"
          v-html="icons.close"
        />
      </div>
      <div
        v-for="item in uploadItems"
        :key="item.name"
        class="it"
      >
        <span
          class="fi"
          :class="fileGlyph(mimeFromName(item.name), item.name).className"
          v-html="fileGlyph(mimeFromName(item.name), item.name).icon"
        /><div class="t">
          <b>{{ item.name }}</b><small>{{ item.done ? 'Done' : `${item.percent}% sent` }}</small><div
            v-if="!item.done"
            class="prog"
          >
            <i :style="{ width: `${item.percent}%` }" />
          </div>
        </div><span
          v-if="item.done"
          class="sync local"
          v-html="icons.syncLocal"
        />
      </div>
    </div>
    <dialog v-if="folderDetails" ref="folderDialog" class="folder-details" aria-labelledby="folder-details-title" @close="folderDetails = null" @click="onFolderBackdrop">
      <h2 id="folder-details-title">{{ folderDetails.name }}</h2>
      <dl><dt>Type</dt><dd>Folder</dd><dt>Location</dt><dd>{{ folderDetails.path }}</dd><dt>Files</dt><dd>{{ folderDetails.childCount }}</dd><dt>Size</dt><dd>{{ formatBytes(folderDetails.size) }}</dd><dt>Modified</dt><dd>{{ formatDate(folderDetails.updatedAt, true) }}</dd></dl>
      <button class="btn" type="button" @click="folderDialog?.close()">Close</button>
      <button class="btn pri" type="button" @click="openPath(folderDetails.path); folderDialog?.close()">Open folder</button>
    </dialog>
    <ShareSheet v-if="shareTarget" :data-source="dataSource" :target="shareTarget" @close="shareTarget = null" @updated="refresh(true)" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, triggerRef, watch } from 'vue';

import FileDetail from './FileDetail.vue';
import ShareSheet from './ShareSheet.vue';
import SharedByMe from './SharedByMe.vue';
import { useFilesExplorerInteractions } from './composables/useFilesExplorerInteractions';
import { useFilesOperationQueue } from './composables/useFilesOperationQueue';

import type { FilesNavigationPayload } from '@pkg/composables/useBrowserTabs';

import { isFilesFolderReplacementDestination, isFilesFolderState, isFilesOperationState, type FilesCollisionDestination, type FilesCollisionPolicy, type FilesCrossCollectionCapability, type FilesDataSource, type FilesFolderState, type FilesIndexCoverage, type FilesItem, type FilesOperationItem, type FilesOperationItemReceipt, type FilesOperationReceipt, type FilesOperationRetry, type FilesSnapshot, type FilesTrashItem } from './types';
import type { ExplorerColumns, ExplorerLocation, ExplorerTarget } from './composables/useFilesExplorerInteractions';

const props = defineProps<{ dataSource: FilesDataSource; tabId: string; navigation?: FilesNavigationPayload }>();
const emit = defineEmits<{ 'navigation-consumed': [] }>();
type Section = 'files' | 'shared' | 'sharedByMe' | 'recent' | 'starred' | 'agent' | 'trash';
type ViewMode = 'list' | 'grid';
interface DisplayEntry extends FilesItem { key: string; name: string; folder: boolean; folderState?:FilesFolderState; trashItem?:FilesTrashItem; agent: boolean; childCount: number; kindClass: string; icon: string; subtitle: string }
interface OperationItem { fileId?:string; folderPath?:string; expectedFolder?:FilesFolderState; sourceSubtreeSignature?:string; targetPath:string; expectedVersionId?:string; expectedRevision?:string }
interface DragSnapshot { sourceIdentity:string; preparationSignature:string; target:ExplorerTarget }
interface DragPreparation { collectionId:string; signature:string; generation:number; anchorKey:string }
interface DragSnapshotRequest { sourceIdentity:string; generation:number; promise:Promise<void> }

// Icon set copied from the approved Files mockup (mockups/files/01-files.html).
const icons = {
  folder:     '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  folderLine: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  users:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 19h5a4.5 4.5 0 0 0-3-4.2"/></svg>',
  clock:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  star:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3.8l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 17l-5.2 2.8 1-5.8L3.6 9.9l5.8-.8z"/></svg>',
  starOn:     '<span class="star on"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3.8l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 17l-5.2 2.8 1-5.8L3.6 9.9l5.8-.8z"/></svg></span>',
  agent:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 8V4M9 4h6"/><circle cx="9" cy="13.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="13.5" r="1.2" fill="currentColor" stroke="none"/></svg>',
  trash:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  search:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/></svg>',
  arrowLeft:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  plus:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  upload:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V5M7 10l5-5 5 5M4 19h16"/></svg>',
  share:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="M8.2 10.8l7.6-4M8.2 13.2l7.6 4"/></svg>',
  list:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  grid:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/></svg>',
  more:       '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18" cy="12" r="1.7"/></svg>',
  close:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  alert:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/></svg>',
  syncLocal:  '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="9" opacity=".16"/><path d="M8 12.5l2.6 2.6L16.5 9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  syncOnline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18a4 4 0 0 1-.5-7.96A5.5 5.5 0 0 1 17 9.5a3.5 3.5 0 0 1 .5 7H7z"/></svg>',
  syncSpin:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 0 1-14.2 5M4 12a8 8 0 0 1 14.2-5"/><path d="M4 7v5h5M20 17v-5h-5"/></svg>',
  file:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/></svg>',
  doc:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
  image:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M20 15l-4.5-4.5L7 19"/></svg>',
  video:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/></svg>',
  audio:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>',
  pdf:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/><path d="M9 17v-5h2a1.5 1.5 0 0 1 0 3H9"/></svg>',
  zip:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M10 4v4h2v4h-2v4h2v4"/></svg>',
  code:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/></svg>',
};

const explorer = useFilesExplorerInteractions(props.tabId);
const operations = useFilesOperationQueue(props.dataSource, props.tabId);
const { error: queueError, pendingRequest } = operations;
const operationHistory = computed(() => {
  const collectionId = snapshot.value?.collection.id;

  return operations.receipts.value.filter((receipt, index) => receiptTouchesCollection(receipt, collectionId) ||
    (operations.active.value && index === 0));
});
const operationReceipt = computed(() => operationHistory.value[0] ?? null);
const undoReceipt = computed(() => [...operationHistory.value].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).find(receipt => receipt.undoSupported && receipt.state !== 'pending'));
const collisionItem = computed(() => operationReceipt.value?.items.find(item => item.state === 'failed' && item.error?.code === 'destination-conflict'));
const applyCollisionToAll = ref(false);
const collisionItems = computed(() => {
  const receipt=operationReceipt.value; const selected=collisionItem.value;

  return receipt && selected ? (applyCollisionToAll.value ? receipt.items.filter(item => item.state === 'failed' && item.error?.code === 'destination-conflict') : [selected]) : [];
});
const canReplaceCollision = computed(() => collisionItems.value.length > 0 && collisionItems.value.every(canReplaceCollisionItem));
const canUndo = computed(() => !busy.value && !loading.value && !operations.receipts.value.some(receipt => receipt.state === 'pending') && Boolean(props.dataSource.undoOperation && undoReceipt.value && receiptTouchesCollection(undoReceipt.value, snapshot.value?.collection.id)));
const { backStack, forwardStack, clipboard } = explorer;
const canGoBack = computed(() => backStack.value.length > 0); const canGoForward = computed(() => forwardStack.value.length > 0);
const snapshot = ref<FilesSnapshot | null>(null); const loading = ref(true); const busy = ref(false); const error = ref('');
const section = ref<Section>('files'); const currentPath = ref(''); const query = ref(''); const sort = ref('modified'); const sortDirection = ref<'asc' | 'desc'>('desc'); const columns = ref<ExplorerColumns>({ name: 360, owner: 190, modified: 160, size: 110 }); const view = ref<ViewMode>('list');
const activeFilters = ref<Record<'type' | 'person' | 'date' | 'folder', string>>({ type: '', person: '', date: '', folder: '' });
const searchResults = ref<FilesItem[] | null>(null); const searchInput = ref<HTMLInputElement | null>(null);
const searchCoverage = ref<FilesIndexCoverage | null>(null);
const selectedKeys = ref(new Set<string>()); const uploadProgress = ref<{ current: number; total: number; name: string; percent: number; done: boolean } | null>(null);
const draggedKeys = ref(new Set<string>()); const dropTargetKey = ref('');
const dragTargets = ref<ExplorerTarget[]>([]); const dragPointer = ref({ x: 0, y: 0 }); let hoverOpenTimer:ReturnType<typeof setTimeout> | undefined;
const dragSnapshots = new Map<string, DragSnapshot>(); const dragSnapshotRequests = new Map<string, DragSnapshotRequest>(); const dragSnapshotGenerations = new Map<string, number>(); let dragPreparation:DragPreparation | undefined; let dragPreparationGeneration=0; let dragSourceCollectionId = ''; let dragSourceCapability:FilesCrossCollectionCapability = 'unavailable';
const selectionAnchor = ref<string | null>(null);
const actionMenu = ref<HTMLElement | null>(null); const menuPosition = ref({ x: 0, y: 0 }); let menuTrigger:HTMLElement | null = null;
const backgroundActionMenu = ref<HTMLElement | null>(null); const backgroundMenu = ref<{ x:number; y:number } | null>(null);
const folderDetails = ref<DisplayEntry | null>(null); const folderDialog = ref<HTMLDialogElement | null>(null);
const operationError = ref(''); const actionTarget = ref<DisplayEntry | null>(null);
const operationNotice = ref('');
const editingKey = ref(''); const renameValue = ref(''); let renameCommitting = false;
const mainSurface = ref<HTMLElement | null>(null); const listSurface = ref<HTMLElement | null>(null); const gridSurface = ref<HTMLElement | null>(null);
const browserSurface = ref<HTMLElement | null>(null);
const marquee = ref<{ left:number; top:number; width:number; height:number; additive:boolean } | null>(null);
let stopPointerGesture:(() => void) | undefined;
let suppressGestureClick = false;
let gestureClickTimer:ReturnType<typeof setTimeout> | undefined;
let refreshGeneration = 0;
const quickLookEntry = ref<DisplayEntry | null>(null); const quickLookUrl = ref(''); const quickLookLoading = ref(false); let quickLookGeneration = 0;
const quickLookDialog = ref<HTMLElement | null>(null); let quickLookTrigger:HTMLElement | null = null;
const uploadLog = ref<{ name: string; percent: number; done: boolean }[]>([]);
// In-progress upload first, then the ones already finished in this batch (the stream only reports the current file).
const uploadItems = computed(() => [...uploadLog.value.filter(item => !item.done), ...uploadLog.value.filter(item => item.done).reverse()]);
const selected = ref<DisplayEntry | null>(null); const detailTab = ref<'details' | 'versions'>('details');
const dragging = ref(false); const favoriteDropActive = ref(false); let refreshTimer:ReturnType<typeof setInterval> | undefined;
const nativeSources = ref<{ fileId:string; name:string; state:string; lastError?:string; recovery:Record<string, unknown> }[]>([]);
const starred = ref(new Set<string>());
const shareTarget = ref<{ id:string; name:string; folder:boolean; path:string; collectionId:string; orgId?:string; ownerUserId?:string; assetKind?:'file' | 'capture' | 'artifact' } | null>(null);

const activeFiles = computed(() => snapshot.value?.files.filter(file => !file.deletedAt) ?? []);
const trashItems = computed(() => snapshot.value?.trash ?? []);
const totalBytes = computed(() => activeFiles.value.reduce((sum, file) => sum + file.size, 0));
const quotaBytes = computed(() => snapshot.value?.collection.storageQuota);
const storagePercent = computed(() => quotaBytes.value ? Math.min(100, Math.max(1, totalBytes.value / quotaBytes.value * 100)) : 0);
const storageWhere = computed(() => snapshot.value?.status.serverConfigured ? 'on server' : 'on this Mac');
const sharedFolders = computed(() => snapshot.value?.collection.sharedFolders ?? []);
const folderFavorites = computed(() => {
  const folders = new Set((snapshot.value?.folders ?? []).map(folder => typeof folder === 'string' ? folder : folder.path));

  return [...starred.value]
    .filter(key => key.startsWith('folder:'))
    .map(key => key.slice('folder:'.length))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map(path => ({
      path,
      name: path.split('/').at(-1) ?? path,
      available: folders.has(path) || activeFiles.value.some(file => file.path.startsWith(`${ path }/`)),
    }));
});
function loadPinnedCollectionIds():Set<string> {
  try {
    const stored = JSON.parse(localStorage.getItem('sulla:files:pinned-collections') ?? '[]');
    return new Set(Array.isArray(stored) ? stored.filter((id):id is string => typeof id === 'string') : []);
  } catch { return new Set() }
}
const pinnedCollectionIds = ref(loadPinnedCollectionIds());
const visibleCollections = computed(() => snapshot.value?.availableCollections?.filter(collection => pinnedCollectionIds.value.has(collection.id)) ?? []);
const currentCollectionPinned = computed(() => Boolean(snapshot.value?.collection.id && pinnedCollectionIds.value.has(snapshot.value.collection.id)));
const readOnlyArea = computed(() => snapshot.value?.collection.systemArea === 'logs' || snapshot.value?.collection.systemArea === 'training-data');
function setCollectionPinned(collectionId:string, pinned:boolean) {
  const next = new Set(pinnedCollectionIds.value);
  if (pinned) next.add(collectionId); else next.delete(collectionId);
  pinnedCollectionIds.value = next;
  localStorage.setItem('sulla:files:pinned-collections', JSON.stringify([...next]));
}
const otherCollections = computed(() => snapshot.value?.availableCollections?.filter(collection=>collection.id!==snapshot.value?.collection.id) ?? []);
const syncState = computed(() => snapshot.value?.status.state ?? 'error');
const retentionDays = computed(() => Number(snapshot.value?.collection.retentionPolicy?.trashDays ?? 90));
const retentionLabel = computed(() => snapshot.value?.collection.retentionPolicy?.mode === 'none' ? 'No automatic disposal' : snapshot.value?.collection.retentionPolicy?.mode ? `Retention: ${ snapshot.value.collection.retentionPolicy.mode }` : `Trash is recoverable for ${ retentionDays.value } days`);
const locationWord = computed(() => ({ local: 'local', server: 'server', cloud: 'Sulla Cloud' }[snapshot.value?.status.location ?? (snapshot.value?.status.serverConfigured ? 'server' : 'local')]));
const brandLine = computed(() => `${ snapshot.value?.collection.accountName || 'Files' } · ${ locationWord.value }`);
const syncLine = computed(() => {
  const status = snapshot.value?.status;
  if (!status) return 'Checking sync…';
  if (status.legacyImport?.state === 'secure-import-required') return status.legacyImport.action || 'Legacy Files data is contained pending secure import';
  if (status.state === 'syncing') return `Syncing ${ status.pendingFiles || '' } file${ status.pendingFiles === 1 ? '' : 's' }`.replace('  ', ' ');
  if (status.state === 'paused') return 'Sync paused · click to resume';
  if (status.state === 'conflict') return 'A file needs a decision';
  if (status.state === 'error') return 'Not syncing · files safe on this Mac';
  if (!status.serverConfigured) return 'Local only · files saved on this Mac';
  return `All files synced${ status.lastSyncAt ? ` · ${ timeAgo(status.lastSyncAt) }` : '' }`;
});
const syncTooltip = computed(() => syncState.value === 'paused' ? 'Resume Files sync' : 'Pause Files sync');
const rootLabel = computed(() => ({ files: 'My Files', shared: 'Shared with me', sharedByMe: 'Shared by me', recent: 'Recent', starred: 'Starred', agent: 'Agent files', trash: 'Trash' }[section.value]));
const pageTitle = computed(() => section.value === 'files' && currentPath.value ? currentPath.value.split('/').at(-1) : rootLabel.value);
const parentFolderLabel = computed(() => currentPath.value.split('/').filter(Boolean).at(-2) ?? rootLabel.value);
const parentPath = computed(() => currentPath.value.split('/').filter(Boolean).slice(0, -1).join('/'));
const crumbs = computed(() => section.value === 'files' ? currentPath.value.split('/').filter(Boolean).map((label, index, parts) => ({ label, path: parts.slice(0, index + 1).join('/') })) : []);
const summaryText = computed(() => `${ visibleEntries.value.length } item${ visibleEntries.value.length === 1 ? '' : 's' } · ${ formatBytes(visibleEntries.value.reduce((sum, entry) => sum + entry.size, 0)) }`);
const indexSummary = computed(() => { const value = snapshot.value?.status.indexing; return value ? `${ value.indexed } indexed · ${ value.partial } partial · ${ value.pending } pending · ${ value.indexing } indexing · ${ value.unsupported } unsupported · ${ value.failed } failed` : 'Unavailable'; });
const accountName = computed(() => snapshot.value?.collection.accountName || 'Signed-in user');
const accountLine = computed(() => {
  const raw = snapshot.value?.collection.accountRole;
  const role = raw ? ({ manage: 'Owner', owner: 'Owner', edit: 'Editor', view: 'Viewer' }[raw] ?? raw.charAt(0).toUpperCase() + raw.slice(1)) : 'Role unavailable';
  const desktops = snapshot.value?.collection.desktopCount;

  return desktops === undefined ? role : `${ role } · ${ desktops } desktop${ desktops === 1 ? '' : 's' }`;
});
// One badge per agent run that left files behind, matching the mockup's "Agent files 2".
const agentCount = computed(() => new Set(activeFiles.value.filter(file => file.createdByType === 'agent-run').map(file => file.createdById)).size);
const sections = computed(() => [
  { id: 'files' as Section, label: 'My Files', icon: icons.folderLine, count: 0, warn: false },
  { id: 'shared' as Section, label: 'Shared with me', icon: icons.users, count: sharedFolders.value.length, warn: false },
  { id: 'sharedByMe' as Section, label: 'Shared by me', icon: icons.share, count: 0, warn: false },
  { id: 'recent' as Section, label: 'Recent', icon: icons.clock, count: 0, warn: false },
  { id: 'starred' as Section, label: 'Starred', icon: icons.star, count: 0, warn: false },
  { id: 'agent' as Section, label: 'Agent files', icon: icons.agent, count: agentCount.value, warn: true },
  { id: 'trash' as Section, label: 'Trash', icon: icons.trash, count: trashItems.value.length, warn: trashItems.value.some(item => item.currentTombstone.undo.state === 'recovery-required') },
]);
const emptyTitle = computed(() => ({ files: 'This folder is empty', shared: 'Nothing shared with you yet', sharedByMe: 'No public links yet', recent: 'No recent files', starred: 'No starred files', agent: 'No agent files to keep', trash: 'Trash is empty' }[section.value]));
const emptyCopy = computed(() => ({ files: 'Drop files here or choose files. Files are stored securely and versioned on every change.', shared: 'Folders teammates share with you appear here.', sharedByMe: 'Links you create appear here.', recent: 'Files you change will appear here.', starred: 'Star important files to find them quickly.', agent: 'Files created by agent runs will appear here with their provenance.', trash: 'Deleted files remain discoverable until the Files service permits disposal.' }[section.value]));
const uploadHeading = computed(() => `Drop files here to upload to ${ pageTitle.value }`);
const dropCopy = computed(() => snapshot.value?.status.serverConfigured ? 'Files sync to the server and are versioned on every change.' : 'Files are encrypted and versioned in Sulla.');
const filters = computed(() => [
  { key: 'type' as const, label: 'Type', any: 'Any', options: [...new Set(activeFiles.value.map(file => kindLabel(file.mime, file.path)))].sort() },
  { key: 'person' as const, label: 'Person', any: 'Anyone', options: [...new Set(activeFiles.value.map(ownerName))].sort() },
  { key: 'date' as const, label: 'Date', any: 'Any time', options: ['Today', 'This week', 'Earlier'] },
  { key: 'folder' as const, label: 'Folder', any: 'This folder', options: [...new Set(activeFiles.value.filter(file => file.path.includes('/')).map(file => file.path.split('/')[0]))].sort() },
]);
const sortLabel = computed(() => ({ name: 'Name', modified: 'Modified', size: 'Size', type: 'Type' }[sort.value] ?? 'Name'));

function fileGlyph(mime:string, path = ''):{ icon: string; className: string } {
  const ext = path.split('.').at(-1)?.toLowerCase() ?? '';
  if (mime.startsWith('image/')) return { icon: icons.image, className: 'img' };
  if (mime.startsWith('video/')) return { icon: icons.video, className: 'vid' };
  if (mime.startsWith('audio/')) return { icon: icons.audio, className: 'aud' };
  if (mime === 'application/pdf') return { icon: icons.pdf, className: 'pdf' };
  if (isArchive(mime, ext)) return { icon: icons.zip, className: 'zip' };
  if (/json|yaml|javascript|typescript|x-sh|x-python/.test(mime) || ['js', 'ts', 'json', 'yaml', 'yml', 'py', 'sh', 'vue', 'css', 'html'].includes(ext)) return { icon: icons.code, className: 'code' };
  if (mime.startsWith('text/') || /document|msword|rtf|opendocument/.test(mime)) return { icon: icons.doc, className: 'doc' };
  return { icon: icons.file, className: 'zip' };
}
function isArchive(mime:string, ext:string) { return /zip|x-tar|gzip|x-7z|x-rar|compressed/.test(mime) || ['zip', 'tar', 'gz', 'tgz', '7z', 'rar'].includes(ext) }
function mimeFromName(name:string) { const ext = name.split('.').at(-1)?.toLowerCase() ?? ''; return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', pdf: 'application/pdf', zip: 'application/zip', md: 'text/markdown', txt: 'text/plain' } as Record<string, string>)[ext] ?? 'application/octet-stream' }
function kindLabel(mime:string, path = '') {
  const ext = path.split('.').at(-1)?.toLowerCase() ?? '';
  if (mime === 'inode/directory') return 'Folder';
  if (mime.includes('markdown') || ext === 'md') return 'Markdown';
  if (mime.startsWith('image/')) return (ext || mime.split('/')[1]).toUpperCase();
  if (mime.startsWith('video/')) return 'Video';
  if (mime.startsWith('audio/')) return 'Audio';
  if (mime === 'application/pdf') return 'PDF';
  if (isArchive(mime, ext)) return 'Archive';
  if (mime.startsWith('text/')) return 'Text';
  return ext ? ext.toUpperCase() : 'File';
}
function toDisplay(file:FilesItem):DisplayEntry {
  const glyph = fileGlyph(file.mime, file.path); const conflict = entrySync(file) === 'conflict';

  return { ...file, key: file.id, name: file.path.split('/').at(-1) || file.path, folder: false, agent: file.createdByType === 'agent-run', childCount: 0, kindClass: glyph.className, icon: glyph.icon, subtitle: conflict ? `Edited on ${ file.conflictDevices || 2 } desktops at once · both copies preserved` : `${ kindLabel(file.mime, file.path) } · v${ file.versionCount } · ${ file.indexStatus }: ${ file.indexReason }` };
}
function toTrashDisplay(item:FilesTrashItem):DisplayEntry {
  const undo = item.currentTombstone.undo.state.replace('-', ' ');
  if (item.kind === 'file') return {
    ...toDisplay(item), key: `trash:file:${ item.id }`, trashItem: item,
    subtitle: `${ kindLabel(item.mime, item.path) } · Trash restore ${ undo }`,
  };

  return {
    id: item.id, key: `trash:folder:${ item.id }`, path: item.path,
    name: item.path.split('/').at(-1) || item.path, folder: true, trashItem: item,
    agent: false, childCount: 0, kindClass: 'folder', icon: icons.folder,
    subtitle: `Folder · Trash restore ${ undo }`, mime: 'inode/directory', size: 0,
    updatedAt: item.deletedAt, deletedAt: item.deletedAt, currentVersionId: '',
    operationRevision: item.revision, versionCount: 0, createdByType: 'user', createdById: '',
    syncState: 'synced', indexStatus: 'indexed', indexReason: 'Folder tombstone.',
    capabilities: item.capabilities,
  };
}
function folderEntry(prefix:string, name:string, children:FilesItem[], folderState?:FilesFolderState):DisplayEntry {
  const newest = [...children].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  const agent = children.length > 0 && children.every(file => file.createdByType === 'agent-run');
  const state = children.some(file => entrySync(file) === 'conflict') ? 'conflict' : children.some(file => entrySync(file) === 'syncing') ? 'syncing' : children.length && children.every(file => entrySync(file) === 'online-only') ? 'online-only' : 'synced';
  const where = agent ? 'made by an agent' : state === 'online-only' ? 'online only' : 'stored in Sulla';
  const size = children.reduce((sum, file) => sum + file.size, 0);

  return { id: `folder:${ prefix }${ name }`, key: `folder:${ prefix }${ name }`, path: `${ prefix }${ name }`, name, folder: true, folderState, agent, childCount: children.length, kindClass: agent ? 'folder agent' : 'folder', icon: agent ? icons.agent : icons.folder, subtitle: `${ children.length } file${ children.length === 1 ? '' : 's' } · ${ where }`, mime: 'inode/directory', size, updatedAt: newest?.updatedAt ?? '', currentVersionId: '', versionCount: 0, createdByType: newest?.createdByType ?? 'user', createdById: newest?.createdById ?? '', ownerDisplayName: newest?.ownerDisplayName, ownerAvatarUrl: newest?.ownerAvatarUrl, syncState: state as FilesItem['syncState'], indexStatus: 'indexed', indexReason: 'Folder indexing is reported per file.' };
}
const visibleEntries = computed<DisplayEntry[]>(() => {
  if (section.value === 'trash') {
    const search = query.value.trim().toLowerCase();
    const entries = trashItems.value.filter(item => !search || item.path.toLowerCase().includes(search)).map(toTrashDisplay);

    return entries.sort((a, b) => {
      const result = sort.value === 'modified' ? Date.parse(a.updatedAt || '0') - Date.parse(b.updatedAt || '0') : sort.value === 'size' ? a.size - b.size : sort.value === 'type' ? a.mime.localeCompare(b.mime) : a.name.localeCompare(b.name, undefined, { numeric: true });

      return sortDirection.value === 'asc' ? result : -result;
    });
  }
  let files = searchResults.value ?? activeFiles.value;
  if (section.value === 'agent') files = files.filter(file => file.createdByType === 'agent-run');
  if (section.value === 'starred') files = files.filter(file => starred.value.has(file.id));
  if (section.value === 'recent') files = [...files].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 50);
  if (section.value === 'shared') files = files.filter(file => sharedFolders.value.some(folder => file.path.startsWith(`${ folder }/`)));
  const search = query.value.trim().toLowerCase();
  const flat = Boolean(search) || ['recent', 'starred', 'trash'].includes(section.value);
  const prefix = currentPath.value && section.value === 'files' ? `${ currentPath.value }/` : '';
  const entries:DisplayEntry[] = []; const folders = new Map<string, FilesFolderState | undefined>();
  for (const file of files) {
    if (!flat && !file.path.startsWith(prefix)) continue;
    const relative = flat ? file.path : file.path.slice(prefix.length); const parts = relative.split('/');
    if (!flat && (parts.length > 1 || file.mime === 'inode/directory')) { if (!folders.has(parts[0])) folders.set(parts[0], undefined) } else if (file.mime !== 'inode/directory') entries.push(toDisplay(file));
  }
  if (!flat && section.value === 'files') for (const folder of snapshot.value?.folders ?? []) {
    const folderPath = typeof folder === 'string' ? folder : folder.path;
    if (folderPath.startsWith(prefix) && folderPath.length > prefix.length) {
      const name = folderPath.slice(prefix.length).split('/')[0];
      const displayedPath = `${ prefix }${ name }`;
      folders.set(name, typeof folder !== 'string' && folder.path === displayedPath ? folder : folders.get(name));
    }
  }
  for (const [name, folderState] of folders) entries.push(folderEntry(prefix, name, files.filter(file => file.path.startsWith(`${ prefix }${ name }/`)), folderState));
  if (section.value === 'starred') {
    for (const key of starred.value) {
      if (!key.startsWith('folder:')) continue;
      const path = key.slice('folder:'.length); const children = activeFiles.value.filter(file => file.path.startsWith(`${ path }/`));
      if (children.length) {
        const state = snapshot.value?.folders?.find(folder => typeof folder !== 'string' && folder.path === path);
        entries.push(folderEntry(`${ path.split('/').slice(0, -1).join('/') }${ path.includes('/') ? '/' : '' }`, path.split('/').at(-1)!, children, typeof state === 'string' ? undefined : state));
      }
    }
  }
  const filtered = entries.filter(entry => (!activeFilters.value.type || kindLabel(entry.mime, entry.path) === activeFilters.value.type) && (!activeFilters.value.person || ownerName(entry) === activeFilters.value.person) && (!activeFilters.value.folder || entry.path.split('/')[0] === activeFilters.value.folder) && (!activeFilters.value.date || dateBucket(entry.updatedAt) === activeFilters.value.date));
  return filtered.sort((a, b) => {
    if (a.folder !== b.folder) return a.folder ? -1 : 1;
    if (a.agent !== b.agent) return a.agent ? 1 : -1;
    let result = sort.value === 'modified' ? Date.parse(a.updatedAt || '0') - Date.parse(b.updatedAt || '0') : sort.value === 'size' ? a.size - b.size : sort.value === 'type' ? a.mime.localeCompare(b.mime) : a.name.localeCompare(b.name, undefined, { numeric: true });

    if (sort.value === 'owner') result = ownerName(a).localeCompare(ownerName(b));
    return sortDirection.value === 'asc' ? result : -result;
  });
});
const groups = computed(() => [
  { label: 'Folders', entries: visibleEntries.value.filter(entry => entry.folder) },
  { label: 'Files', entries: visibleEntries.value.filter(entry => !entry.folder) },
].filter(group => group.entries.length));
const allVisibleSelected = computed(() => Boolean(visibleEntries.value.length) && visibleEntries.value.every(entry => selectedKeys.value.has(entry.key)));
const selectedFileForShare = computed(() => visibleEntries.value.find(entry => !entry.folder && selectedKeys.value.has(entry.key)) ?? selected.value);
const selectedEntries = computed(() => visibleEntries.value.filter(entry => selectedKeys.value.has(entry.key)));
const canPaste = computed(() => Boolean(snapshot.value && section.value === 'files' && clipboard.value?.targets.length &&
  (clipboard.value.collectionId === snapshot.value.collection.id ||
   (clipboard.value.sourceCapability !== 'unavailable' && props.dataSource.capabilities.crossCollectionOperations !== 'unavailable' &&
    clipboard.value.targets.every(target => !target.folder || /^[0-9a-f]{64}$/.test(target.sourceSubtreeSignature ?? ''))))));
const crossCollectionClipboardMessage = computed(() => {
  if (!clipboard.value || !snapshot.value || clipboard.value.collectionId === snapshot.value.collection.id) return '';
  if (canPaste.value) return `Ready to ${ clipboard.value.mode === 'cut' ? 'move' : 'copy' } ${ clipboard.value.targets.length } item${ clipboard.value.targets.length === 1 ? '' : 's' } from another collection.`;
  return 'Clipboard kept from another collection, but the source or destination does not authorize this transfer.';
});
const canEmptyTrash = computed(() => Boolean(props.dataSource.purgeTrashItem));
const quickLookEntries = computed(() => visibleEntries.value.filter(entry => !entry.folder));
const quickLookIndex = computed(() => quickLookEntry.value ? quickLookEntries.value.findIndex(entry => entry.key === quickLookEntry.value?.key) : -1);
const marqueeStyle = computed(() => marquee.value ? { left: `${ marquee.value.left }px`, top: `${ marquee.value.top }px`, width: `${ marquee.value.width }px`, height: `${ marquee.value.height }px` } : {});

async function refresh(silent = false, afterMutation = false) {
  if (busy.value && !afterMutation) return;
  const generation = ++refreshGeneration; const source = props.dataSource;
  const isCurrent = () => mounted && generation === refreshGeneration && source === props.dataSource;
  if (!silent) loading.value = true;
  try {
    const loaded = await source.load();
    if (!isCurrent()) return;
    const [stars, sources] = await Promise.all([source.listStars(loaded.collection.id), source.listNativeSources?.() ?? Promise.resolve([])]);
    if (!isCurrent()) return;
    nativeSources.value = sources; snapshot.value = loaded; starred.value = new Set(stars.map(star => star.fileId ?? `folder:${ star.folderPath }`)); error.value = '';
    await operations.restore(loaded.collection.id);
    if (!isCurrent()) return;
    selectedKeys.value = new Set([...selectedKeys.value].filter(key => visibleEntries.value.some(entry => entry.key === key)));
  } catch (cause) { if (isCurrent()) error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { if (isCurrent()) loading.value = false }
}
async function runMutation(operation:() => Promise<void>, reload = true) {
  if (readOnlyArea.value && reload) return false;
  if (busy.value || loading.value || error.value || !snapshot.value) return false;
  busy.value = true; refreshGeneration++; operationError.value = ''; stopPointerGesture?.();
  try { await operation(); return true }
  catch (cause) { if (mounted) operationError.value = cause instanceof Error ? cause.message : String(cause); return false }
  finally { if (reload && mounted) await refresh(true, true); busy.value = false }
}
async function selectCollection(collectionId:string) {
  if (busy.value || loading.value || !props.dataSource.selectCollection || collectionId === snapshot.value?.collection.id) return;
  if (!dragTargets.value.length) clearInternalDrag();
  cancelRename(); closeQuickLook();
  stopPointerGesture?.(); closeActions(false); closeBackgroundActions(); query.value = ''; searchGeneration++;
  props.dataSource.selectCollection(collectionId); section.value = 'files'; currentPath.value = ''; selected.value = null; searchResults.value = null; searchCoverage.value = null; selectedKeys.value = new Set();
  await refresh();
  explorer.clearForCollection(collectionId); loadFolderPreferences();
}
function setCollectionDropEffect(event:DragEvent) { if (event.dataTransfer) event.dataTransfer.dropEffect='move' }
async function onCollectionDrop(collectionId:string,event:DragEvent) {
  if (busy.value || loading.value || !dragTargets.value.length || collectionId===snapshot.value?.collection.id) return;
  if (dragSourceCapability==='unavailable' || dragTargets.value.some(target=>target.folder && !/^[0-9a-f]{64}$/.test(target.sourceSubtreeSignature ?? ''))) return;
  const targets=[...dragTargets.value]; const sourceCollectionId=dragSourceCollectionId; const sourceCapability=dragSourceCapability;
  event.stopPropagation();
  await selectCollection(collectionId);
  if (snapshot.value?.collection.id!==collectionId || section.value!=='files' || currentPath.value!=='') {
    clearInternalDrag();
    operationError.value='The destination collection did not finish loading, so nothing was moved.';
    return;
  }
  const items=targets.map(target=>operationTarget(target,''));
  clearInternalDrag();
  await perform('move',items,sourceCollectionId,sourceCapability);
}
async function upload() { if (!props.dataSource.capabilities.upload || section.value !== 'files') return; const destination = currentPath.value; await runMutation(async() => { await props.dataSource.chooseUpload(destination) }) }
async function reindex(entry:FilesItem) { await runMutation(() => props.dataSource.reindex(entry.id)) }
async function newFolder() {
  if (readOnlyArea.value) return;
  if (busy.value || loading.value || section.value !== 'files' || (!props.dataSource.capabilities.upload && !operations.supported())) return;
  const name = window.prompt('Name this folder')?.trim(); if (!name) return;
  if (name.includes('/') || name === '.' || name === '..') { operationError.value = 'Enter a folder name without path separators.'; return }
  const path = joinPath(currentPath.value, name);
  if (operations.supported()) await submitReceiptItems([{ itemId: crypto.randomUUID(), action: 'create-folder', targetPath: path }]);
  else await runMutation(() => props.dataSource.createFolder(path));
}
async function newFile() {
  if (readOnlyArea.value) return;
  if (busy.value || loading.value || section.value !== 'files' || !props.dataSource.createFile) return;
  const name=window.prompt('Name this file','untitled.txt')?.trim(); if(!name) return;
  if(name.includes('/') || name==='.' || name==='..'){ operationError.value='Enter a file name without path separators.'; return }
  await runMutation(()=>props.dataSource.createFile!(joinPath(currentPath.value,name)));
}
async function chooseNativeSource() { if (props.dataSource.chooseNativeSource) await runMutation(async() => { await props.dataSource.chooseNativeSource!() }) }
async function recoverNativeSource(fileId:string) { if (props.dataSource.recoverNativeSource) await runMutation(async() => { await props.dataSource.recoverNativeSource!(fileId) }) }
function shareEntry(entry:DisplayEntry | null) {
  if (busy.value || !entry || entry.folder || !props.dataSource.createPublicLink || !snapshot.value) return;
  const capture = /(^|\/)(screenshots?|recordings?|captures?)(\/|$)/i.test(entry.path);
  shareTarget.value = { id: entry.id, name: entry.name, folder: false, path: entry.path, collectionId: snapshot.value.collection.id, orgId: snapshot.value.collection.orgId, ownerUserId: snapshot.value.collection.ownerUserId, assetKind: entry.agent ? 'artifact' : capture ? 'capture' : 'file' };
}
function shareSelectedFile() { shareEntry(selectedFileForShare.value ?? null) }
function shareCurrentFolder() {
  if (busy.value || !snapshot.value?.collection.orgId || !props.dataSource.shareFolder || !props.dataSource.listMembers || !currentPath.value || !props.dataSource.capabilities.orgSharing) return;
  shareTarget.value = { id: `folder:${ currentPath.value }`, name: currentPath.value.split('/').at(-1) || 'My Files', folder: true, path: currentPath.value, collectionId: snapshot.value.collection.id, orgId: snapshot.value.collection.orgId, ownerUserId: snapshot.value.collection.ownerUserId };
}
async function togglePause() { const paused = syncState.value !== 'paused'; await runMutation(async() => { await props.dataSource.setPaused(paused) }) }
function currentLocation():ExplorerLocation { return { collectionId: snapshot.value?.collection.id ?? '', section: section.value, path: currentPath.value } }
function applyLocation(location:ExplorerLocation) {
  if (busy.value || loading.value) return;
  stopPointerGesture?.(); cancelRename(); closeQuickLook();
  if (location.collectionId && location.collectionId !== snapshot.value?.collection.id && props.dataSource.selectCollection) props.dataSource.selectCollection(location.collectionId);
  closeActions(false); closeBackgroundActions(); selectionAnchor.value = null; section.value = location.section as Section; currentPath.value = location.path; query.value = ''; searchResults.value = null; selected.value = null; selectedKeys.value = new Set(); loadFolderPreferences();
}
function navigate(location:ExplorerLocation, track = true) { if (busy.value || loading.value) return; const current = currentLocation(); if (track) explorer.visit(current, location); applyLocation(location) }
function selectSection(next:Section) { navigate({ ...currentLocation(), section: next, path: '' }) }
function openRoot() { navigate({ ...currentLocation(), section: 'files', path: '' }) }
function openPath(next:string) { navigate({ ...currentLocation(), section: 'files', path: next }) }
function openParent() { openPath(parentPath.value) }
function goBack() { if (busy.value || loading.value) return; const location = explorer.back(currentLocation()); if (location) applyLocation(location) }
function goForward() { if (busy.value || loading.value) return; const location = explorer.forward(currentLocation()); if (location) applyLocation(location) }
function onMouseNavigation(event:MouseEvent) { if (event.button === 3) { event.preventDefault(); goBack() } else if (event.button === 4) { event.preventDefault(); goForward() } }
function focusEntry(entry:DisplayEntry, event:MouseEvent | KeyboardEvent) {
  if (busy.value) return;
  closeActions(false);
  closeBackgroundActions();
  if (event instanceof MouseEvent) (event.currentTarget as HTMLElement | null)?.focus();
  if (event.shiftKey && selectionAnchor.value) {
    const entries = groups.value.flatMap(group => group.entries);
    const start = entries.findIndex(item => item.key === selectionAnchor.value); const end = entries.findIndex(item => item.key === entry.key);
    if (start >= 0 && end >= 0) { selectedKeys.value = new Set([...(event.metaKey || event.ctrlKey ? selectedKeys.value : []), ...entries.slice(Math.min(start, end), Math.max(start, end) + 1).map(item => item.key)]); return }
  }
  selectionAnchor.value = entry.key;
  if (event.metaKey || event.ctrlKey) toggleSelected(entry.key); else selectedKeys.value = new Set([entry.key]);
}
function onEntryKeydown(entry:DisplayEntry, event:KeyboardEvent) {
  if (event.target !== event.currentTarget) return;
  event.stopPropagation();
  if (event.repeat && (event.key === 'Delete' || event.key === 'Backspace')) { event.preventDefault(); return }
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) { event.preventDefault(); undoLastOperation(); return }
  const entries = visibleEntries.value; const index = entries.findIndex(item => item.key === entry.key);
  if (isMac && event.metaKey && event.key === 'ArrowDown') { event.preventDefault(); activate(entry); return }
  if ((event.metaKey || event.ctrlKey) && event.key === 'ArrowUp') { event.preventDefault(); openParent(); return }
  if (quickLookEntry.value) { onKeydown(event); return }
  if (['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(event.key)) {
    event.preventDefault(); const delta = ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1; const next = entries[Math.max(0, Math.min(entries.length - 1, index + delta))];
    if (next) { focusEntry(next, event); nextTick(() => browserSurface.value?.querySelector<HTMLElement>(`[data-entry-key="${ CSS.escape(next.key) }"]`)?.focus()) }
  } else if (event.key === ' ' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); openQuickLook(entry) }
  else if ((isMac && event.key === 'Enter') || (!isMac && event.key === 'F2')) { event.preventDefault(); beginRename(entry) }
  else if ((!isMac && event.key === 'Enter') || (isMac && event.metaKey && event.key === 'ArrowDown')) { event.preventDefault(); activate(entry) }
  else if ((event.metaKey || event.ctrlKey) && event.key === 'ArrowUp') { event.preventDefault(); openParent() }
  else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); selectedKeys.value = new Set(entries.map(item => item.key)) }
  else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') { event.preventDefault(); copyToClipboard('copy') }
  else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'x') { event.preventDefault(); copyToClipboard('cut') }
  else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v' && canPaste.value) { event.preventDefault(); pasteClipboard() }
  else if ((event.key === 'Delete' || (event.metaKey && event.key === 'Backspace')) && section.value !== 'trash') { event.preventDefault(); trashSelected() }
  else if (event.key === 'Escape') { event.preventDefault(); clearSelection() }
  else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); openActions(entry, event) }
}
async function showDetails(entry:DisplayEntry) { if (busy.value || loading.value) return; closeActions(false); if (!entry.folder) { selectEntry(entry); return } folderDetails.value = entry; await nextTick(); folderDialog.value?.showModal() }
function onFolderBackdrop(event:MouseEvent) { const dialog = folderDialog.value; if (dialog && event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close() } }
function canShareEntry(entry:DisplayEntry) { return entry.folder ? Boolean(snapshot.value?.collection.orgId && props.dataSource.capabilities.orgSharing && props.dataSource.shareFolder && props.dataSource.listMembers) : props.dataSource.capabilities.publicLinks }

async function activate(entry:DisplayEntry) { if (section.value === 'trash') { selectedKeys.value = new Set([entry.key]); if (!entry.folder) selectEntry(entry); return } if (entry.folder) openPath(entry.path); else await runMutation(() => props.dataSource.openFile(entry.id, entry.currentVersionId), false) }
function resolveConflict(entry:DisplayEntry) { selectedKeys.value = new Set([entry.key]); selectEntry(entry) }
function selectEntry(entry:DisplayEntry) { if (busy.value || loading.value) return; stopPointerGesture?.(); cancelRename(); if (entry.folder) { openPath(entry.path); return } selected.value = entry; detailTab.value = entrySync(entry) === 'conflict' ? 'versions' : 'details' }
async function openLinked(fileId:string) { const file = snapshot.value?.files.find(item => item.id === fileId); if (file) selectEntry(toDisplay(file)); else await runMutation(() => props.dataSource.openFile(fileId), false) }
function onBrowserDragEnter(event:DragEvent) { if (!draggedKeys.value.size && event.dataTransfer?.types.includes('Files') && props.dataSource.capabilities.upload) dragging.value = true }
function onBrowserDragOver(event:DragEvent) { if (!draggedKeys.value.size && event.dataTransfer?.types.includes('Files') && props.dataSource.capabilities.upload) dragging.value = true }
function onDragLeave(event:DragEvent) { if (!event.currentTarget || !(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) dragging.value = false; }
async function onDrop(event:DragEvent) {
  if (readOnlyArea.value) { clearInternalDrag(); return }
  dragging.value = false;
  if (busy.value || loading.value || section.value !== 'files' || selected.value) { clearInternalDrag(); return }
  if (dragTargets.value.length) { const targets = dragTargets.value.map(target => operationTarget(target, currentPath.value)); const sourceCollectionId=dragSourceCollectionId; const sourceCapability=dragSourceCapability; clearInternalDrag(); await perform('move', targets, sourceCollectionId, sourceCapability); return }
  if (!event.dataTransfer?.types.includes('Files')) return;
  if (!props.dataSource.capabilities.upload) return;
  const files = [...event.dataTransfer.files];
  if (!files.length) return;
  const destination = currentPath.value;
  await runMutation(async() => {
    if (props.dataSource.uploadDroppedFiles) await props.dataSource.uploadDroppedFiles(files, destination);
    else {
      const paths = files.map(file => (file as File & { path?:string }).path).filter((value):value is string => Boolean(value));
      if (paths.length !== files.length) throw new Error('This Desktop build cannot read one or more dropped files. Use Choose files instead.');
      await props.dataSource.uploadPaths(paths, destination);
    }
  });
}
async function keepBothConflict(entry:DisplayEntry) { if (!props.dataSource.keepConflictCopies) return; selectedKeys.value = new Set([entry.key]); selectEntry(entry); await runMutation(() => props.dataSource.keepConflictCopies!(entry)); const updated = snapshot.value?.files.find(file => file.id === entry.id); selected.value = updated ? toDisplay(updated) : null }
function dragEntriesFor(entry:DisplayEntry) {
  const selected = selectedEntries.value;
  const requested = selectedKeys.value.has(entry.key) && selected.length ? selected : [entry];
  const selectedFolders = requested.filter(item => item.folder).map(item => item.path);

  return requested.filter(item => item.folder || !selectedFolders.some(folder => item.path.startsWith(`${ folder }/`)));
}
function dragEntryIdentity(entry:DisplayEntry,collectionId:string) {
  const folder=entry.folderState;
  const descendants=entry.folder ? snapshot.value?.files.filter(file=>file.path===entry.path || file.path.startsWith(`${ entry.path }/`)).map(file=>JSON.stringify([file.id,file.path,file.currentVersionId,file.operationRevision,file.deletedAt])).sort() : undefined;
  const folders=entry.folder ? snapshot.value?.folders?.filter(item=>(typeof item==='string'?item:item.path).startsWith(`${ entry.path }/`)).map(item=>JSON.stringify(item)).sort() : undefined;

  return JSON.stringify(entry.folder ? [collectionId,entry.key,entry.path,folder?.collectionId,folder?.folderId,folder?.path,folder?.revision,descendants,folders] : [collectionId,entry.key,entry.path,entry.currentVersionId,entry.operationRevision]);
}
function dragSelectionSignature(entries:DisplayEntry[],collectionId:string) {
  return entries.map(entry=>dragEntryIdentity(entry,collectionId)).sort().join('\n');
}
function preparedDragSnapshot(entry:DisplayEntry,preparation:DragPreparation) {
  const record=dragSnapshots.get(dragSnapshotKey(preparation.collectionId,entry.path));

  return record?.sourceIdentity===dragEntryIdentity(entry,preparation.collectionId) && record.preparationSignature===preparation.signature ? record.target : undefined;
}
function invalidateDragPreparation() {
  dragPreparation=undefined; dragPreparationGeneration++; dragSnapshots.clear(); dragSnapshotRequests.clear(); dragSnapshotGenerations.clear();
}
function beginDragPreparation(entries:DisplayEntry[],collectionId:string,anchorKey:string) {
  const signature=dragSelectionSignature(entries,collectionId);

  if (dragPreparation?.collectionId===collectionId && dragPreparation.signature===signature) return dragPreparation;
  invalidateDragPreparation();
  dragPreparation={ collectionId,signature,generation:dragPreparationGeneration,anchorKey };
  return dragPreparation;
}
function onEntryDragStart(entry:DisplayEntry, event:DragEvent) {
  if (readOnlyArea.value) { event.preventDefault(); return }
  if (section.value !== 'files' || busy.value || loading.value || !event.dataTransfer) { event.preventDefault(); return }
  const entries=dragEntriesFor(entry);
  const collectionId=snapshot.value?.collection.id;
  if (!collectionId) { event.preventDefault(); return }
  const preparation=beginDragPreparation(entries,collectionId,entry.key);
  const missingFolders=entries.filter(item=>item.folder && !preparedDragSnapshot(item,preparation));
  if (missingFolders.length) {
    missingFolders.forEach(item=>captureDragSnapshot(item,preparation).catch(()=>undefined));
    operationNotice.value='Drag within this collection now. Drag again after the exact folder source snapshot is ready to move it to another collection.';
  } else operationNotice.value='';
  draggedKeys.value = new Set(entries.map(item => item.key));
  // A running gesture keeps these exact targets; late readiness only serves the next gesture.
  dragTargets.value = entries.map(item => item.folder && !missingFolders.length ? preparedDragSnapshot(item,preparation) ?? toTarget(item) : toTarget(item));
  dragSourceCollectionId=collectionId;
  dragSourceCapability=missingFolders.length ? 'unavailable' : props.dataSource.capabilities.crossCollectionOperations ?? 'unavailable';
  if (!selectedKeys.value.has(entry.key)) selectedKeys.value = new Set([entry.key]);
  event.dataTransfer.effectAllowed = 'all';
  event.dataTransfer.setData('application/x-sulla-files', JSON.stringify(dragTargets.value));
  if (!missingFolders.length) invalidateDragPreparation();
}
function canDropOnFolder(entry:DisplayEntry) { return entry.folder && draggedKeys.value.size > 0 && !busy.value }
function onFolderDragEnter(entry:DisplayEntry, event:DragEvent) { if (canDropOnFolder(entry)) { event.preventDefault(); event.stopPropagation(); dropTargetKey.value = entry.key; scheduleHoverOpen(entry) } }
function onFolderDragOver(entry:DisplayEntry, event:DragEvent) { if (canDropOnFolder(entry)) { event.preventDefault(); event.stopPropagation(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; dropTargetKey.value = entry.key; updateDragPointer(event) } }
function onFolderDragLeave(entry:DisplayEntry, event:DragEvent) { if (dropTargetKey.value === entry.key && !(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) { dropTargetKey.value = ''; cancelHoverOpen() } }
async function onFolderDrop(entry:DisplayEntry, event:DragEvent) {
  if (!canDropOnFolder(entry)) return;
  event.preventDefault(); event.stopPropagation();
  const targets = dragTargets.value.map(target => operationTarget(target, entry.path)); const sourceCollectionId=dragSourceCollectionId; const sourceCapability=dragSourceCapability;
  clearInternalDrag();
  if (targets.length) await perform('move', targets, sourceCollectionId, sourceCapability);
}
function toTarget(entry:DisplayEntry):ExplorerTarget { return { key: entry.key, ...(entry.folder ? { folderPath: entry.path, expectedFolder: entry.folderState ? { ...entry.folderState } : undefined } : { fileId: entry.id, expectedVersionId: entry.currentVersionId, expectedRevision: entry.operationRevision }), path: entry.path, name: entry.name, folder: entry.folder } }
function operationTarget(target:ExplorerTarget, destination:string):OperationItem { return { ...(target.folder ? { folderPath: target.folderPath, expectedFolder: target.expectedFolder, sourceSubtreeSignature:target.sourceSubtreeSignature } : { fileId: target.fileId, expectedVersionId: target.expectedVersionId, expectedRevision: target.expectedRevision }), targetPath: joinPath(destination, target.name) } }
function dragSnapshotKey(collectionId:string,path:string) { return `${ collectionId }:${ path }` }
async function captureTarget(entry:DisplayEntry,collectionId:string):Promise<ExplorerTarget> {
  const target=toTarget(entry);
  if (!entry.folder) return target;
  if (!props.dataSource.folderOperationState) return target;
  try {
    const state=await props.dataSource.folderOperationState(collectionId,entry.path);
    if (state.collectionId!==collectionId || state.path!==entry.path || !/^[0-9a-f]{64}$/.test(state.subtreeSignature) || Boolean(state.folderId)!==Boolean(state.revision)) return target;
    return { ...target, expectedFolder:state.folderId && state.revision ? { collectionId,folderId:state.folderId,path:state.path,revision:state.revision } : undefined, sourceSubtreeSignature:state.subtreeSignature };
  } catch { return target }
}
async function captureDragSnapshot(entry:DisplayEntry,preparation:DragPreparation) {
  const collectionId=preparation.collectionId;
  if (!entry.folder || preparedDragSnapshot(entry,preparation)) return;
  const key=dragSnapshotKey(collectionId,entry.path); const sourceIdentity=dragEntryIdentity(entry,collectionId);
  const pending=dragSnapshotRequests.get(key);
  if (pending?.sourceIdentity===sourceIdentity && pending.generation===preparation.generation) { await pending.promise; return }
  const generation=(dragSnapshotGenerations.get(key) ?? 0)+1;
  dragSnapshotGenerations.set(key,generation);
  const promise=(async() => {
    const captured=await captureTarget(entry,collectionId);
    if (entry.folderState && (captured.expectedFolder?.folderId!==entry.folderState.folderId || captured.expectedFolder?.revision!==entry.folderState.revision)) return;
    const current=visibleEntries.value.find(item=>item.key===entry.key);
    if (mounted && section.value==='files' && dragSnapshotGenerations.get(key)===generation && dragPreparation?.generation===preparation.generation && dragPreparation.signature===preparation.signature && snapshot.value?.collection.id===collectionId && current && dragEntryIdentity(current,collectionId)===sourceIdentity && dragSelectionSignature(dragEntriesFor(current),collectionId)===preparation.signature && captured.sourceSubtreeSignature) {
      dragSnapshots.set(key,{ sourceIdentity,preparationSignature:preparation.signature,target:captured });
    }
  })();
  dragSnapshotRequests.set(key,{ sourceIdentity,generation:preparation.generation,promise });
  try { await promise } finally { if (dragSnapshotRequests.get(key)?.promise===promise) dragSnapshotRequests.delete(key) }
}
function prepareDragSnapshot(entry:DisplayEntry) {
  const collectionId=snapshot.value?.collection.id;
  if (section.value!=='files' || busy.value || loading.value || !collectionId) return;
  const entries=dragEntriesFor(entry); const preparation=beginDragPreparation(entries,collectionId,entry.key);
  entries.filter(item=>item.folder && !preparedDragSnapshot(item,preparation)).forEach(item=>captureDragSnapshot(item,preparation).catch(()=>undefined));
}
function scheduleHoverOpen(entry:DisplayEntry) { cancelHoverOpen(); hoverOpenTimer = setTimeout(() => { if (dropTargetKey.value === entry.key && dragTargets.value.length) openPath(entry.path) }, 750) }
function cancelHoverOpen() { if (hoverOpenTimer) clearTimeout(hoverOpenTimer); hoverOpenTimer = undefined }
function updateDragPointer(event:DragEvent) { dragPointer.value = { x: event.clientX, y: event.clientY } }
function onSurfaceDragOver(event:DragEvent) { updateDragPointer(event); const surface = mainSurface.value; if (!surface) return; const rect = surface.getBoundingClientRect(); if (event.clientY < rect.top + 64) surface.scrollTop -= 18; else if (event.clientY > rect.bottom - 64) surface.scrollTop += 18 }
function canFavoriteDrag() {
  return !busy.value && !loading.value && Boolean(snapshot.value?.collection.id) && dragSourceCollectionId === snapshot.value?.collection.id && draggedKeys.value.size > 0 && dragTargets.value.length > 0 && dragTargets.value.every(target => target.folder && Boolean(target.folderPath));
}
function onFavoriteDragEnter(event:DragEvent) {
  event.preventDefault(); event.stopPropagation(); cancelHoverOpen();
  favoriteDropActive.value = canFavoriteDrag();
  if (event.dataTransfer) event.dataTransfer.dropEffect = favoriteDropActive.value ? 'link' : 'none';
}
function onFavoriteDragOver(event:DragEvent) {
  event.preventDefault(); event.stopPropagation(); cancelHoverOpen();
  favoriteDropActive.value = canFavoriteDrag();
  if (event.dataTransfer) event.dataTransfer.dropEffect = favoriteDropActive.value ? 'link' : 'none';
}
function onFavoriteDragLeave(event:DragEvent) {
  event.stopPropagation();
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) favoriteDropActive.value = false;
}
async function onFavoriteDrop(event:DragEvent) {
  event.preventDefault(); event.stopPropagation(); cancelHoverOpen();
  const collectionId = snapshot.value?.collection.id;
  const paths = canFavoriteDrag() ? [...new Set(dragTargets.value.map(target => target.folderPath!).filter(Boolean))] : [];
  clearInternalDrag();
  if (!collectionId || !paths.length || busy.value || loading.value) return;
  const additions = paths.filter(path => !starred.value.has(`folder:${ path }`));
  if (!additions.length) return;
  await runMutation(async() => {
    for (const folderPath of additions) await props.dataSource.setStar(collectionId, { folderPath }, true);
  });
}
async function setFolderFavorite(path:string, favorite:boolean) {
  const collectionId = snapshot.value?.collection.id;
  if (!collectionId || busy.value || loading.value || starred.value.has(`folder:${ path }`) === favorite) return;
  await runMutation(() => props.dataSource.setStar(collectionId, { folderPath: path }, favorite));
}
function onNavigationDragOver(_path:string, event:DragEvent) { if (!dragTargets.value.length) return; event.stopPropagation(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; updateDragPointer(event) }
async function onNavigationDrop(path:string, event:DragEvent) { if (!dragTargets.value.length) return; event.stopPropagation(); const targets = dragTargets.value.map(target => operationTarget(target, path)); const sourceCollectionId=dragSourceCollectionId; const sourceCapability=dragSourceCapability; clearInternalDrag(); await perform('move', targets, sourceCollectionId, sourceCapability) }
function clearInternalDrag() { cancelHoverOpen(); draggedKeys.value = new Set(); dragTargets.value = []; dragSourceCollectionId=''; dragSourceCapability='unavailable'; dropTargetKey.value = ''; favoriteDropActive.value = false }
function formatBytes(bytes:number) { if (!bytes) return '0 B'; const units = ['B', 'KB', 'MB', 'GB', 'TB']; const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1); const value = bytes / 1024 ** index; return `${ index < 2 || value >= 100 ? Math.round(value) : Number(value.toFixed(1)) } ${ units[index] }` }
function formatDate(value:string, detailed = false) { if (!value) return '—'; const date = new Date(value); return new Intl.DateTimeFormat(undefined, detailed ? { dateStyle: 'medium', timeStyle: 'short' } : { month: 'short', day: 'numeric' }).format(date) }
function dayLabel(date:Date) { const now = new Date(); if (date.toDateString() === now.toDateString()) return 'Today'; const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1); if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'; return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date) }
function formatRelative(value:string) { if (!value) return '—'; const date = new Date(value); return `${ dayLabel(date) }, ${ new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date) }` }
function formatShort(value:string) { return value ? dayLabel(new Date(value)) : '—' }
function timeAgo(value:string) { const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60_000)); if (minutes < 1) return 'just now'; if (minutes < 60) return `${ minutes } min ago`; const hours = Math.round(minutes / 60); return hours < 24 ? `${ hours } hr ago` : formatShort(value) }
function dateBucket(value:string) { const age = Date.now() - Date.parse(value || '0'); return age < 86_400_000 ? 'Today' : age < 604_800_000 ? 'This week' : 'Earlier' }
function ownerName(entry:FilesItem) { const collection = snapshot.value?.collection; if (!entry.ownerDisplayName && entry.createdByType !== 'agent-run' && collection?.accountName && collection.ownerUserId && entry.createdById === collection.ownerUserId) return collection.accountName; return entry.ownerDisplayName || (entry.createdByType === 'agent-run' ? entry.createdById || 'Sulla agent' : entry.createdById || 'Unknown owner') }
function initials(name:string) { const words = name.replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean); return ((words[0]?.[0] ?? '?') + (words.length > 1 ? words[1][0] : '')).toUpperCase() }
function ownerInitials(entry:FilesItem) { return entry.createdByType === 'agent-run' ? ownerName(entry).charAt(0).toUpperCase() : initials(ownerName(entry)) }
function avatarClass(entry:FilesItem) { if (entry.createdByType === 'agent-run') return 'a'; const name = ownerName(entry); if (name === accountName.value || name.toLowerCase() === snapshot.value?.collection.accountName?.toLowerCase()) return ''; const tones = ['m', 'd', 'p']; return tones[[...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % tones.length] }
function entrySync(entry:FilesItem) { return entry.syncState || (syncState.value === 'syncing' ? 'syncing' : 'synced') }
function syncClass(entry:FilesItem) { return ({ synced: 'local', syncing: 'syncing', 'online-only': 'online', conflict: 'conflict' } as Record<string, string>)[entrySync(entry)] ?? 'local' }
function syncIcon(entry:FilesItem) { return ({ synced: icons.syncLocal, syncing: icons.syncSpin, 'online-only': icons.syncOnline, conflict: icons.alert } as Record<string, string>)[entrySync(entry)] ?? icons.syncLocal }
function syncText(entry:FilesItem) { return ({ synced: snapshot.value?.status.location === 'server' ? 'Stored on Sulla Server' : 'Stored in Sulla', syncing: 'Syncing', 'online-only': 'Online only', conflict: 'Conflict' } as Record<string, string>)[entrySync(entry)] ?? 'Stored in Sulla' }
function clearFilters() { activeFilters.value = { type: '', person: '', date: '', folder: '' } }
function toggleSelected(key:string) { selectionAnchor.value = key; const next = new Set(selectedKeys.value); next.has(key) ? next.delete(key) : next.add(key); selectedKeys.value = next }
function toggleAll() { selectedKeys.value = allVisibleSelected.value ? new Set() : new Set(visibleEntries.value.map(entry => entry.key)) }
async function toggleStar(id:string) { if (!snapshot.value) return; const collectionId = snapshot.value.collection.id; const entry = visibleEntries.value.find(item => item.id === id); if (!entry) return; const next = !starred.value.has(id); await runMutation(async() => { await props.dataSource.setStar(collectionId, entry.folder ? { folderPath: entry.path } : { fileId: entry.id }, next); const changed = new Set(starred.value); next ? changed.add(id) : changed.delete(id); starred.value = changed }, false) }
function closeActions(restoreFocus = true) { actionTarget.value = null; if (restoreFocus) menuTrigger?.focus() }
async function openActions(entry:DisplayEntry, event:MouseEvent | KeyboardEvent) {
  closeBackgroundActions();
  if (!selectedKeys.value.has(entry.key)) selectedKeys.value = new Set([entry.key]);
  menuTrigger = event.currentTarget as HTMLElement; const rect = menuTrigger.getBoundingClientRect();
  menuPosition.value = event instanceof MouseEvent && event.type === 'contextmenu' ? { x: event.clientX, y: event.clientY } : { x: rect.left, y: rect.bottom };
  actionTarget.value = entry; await nextTick(); const menu = actionMenu.value; if (!menu) return;
  const bounds = menu.getBoundingClientRect();
  menuPosition.value = { x: Math.max(4, Math.min(menuPosition.value.x, window.innerWidth - bounds.width - 4)), y: Math.max(4, Math.min(menuPosition.value.y, window.innerHeight - bounds.height - 4)) };
  menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
}
function dismissActions(event:PointerEvent) { if (actionTarget.value && !actionMenu.value?.contains(event.target as Node)) closeActions(false); if (backgroundMenu.value && !backgroundActionMenu.value?.contains(event.target as Node)) closeBackgroundActions() }
function onMenuKeydown(event:KeyboardEvent) {
  event.stopPropagation();
  const menu = event.currentTarget as HTMLElement;
  if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); if (menu === actionMenu.value) closeActions(); else { closeBackgroundActions(); mainSurface.value?.focus() } return }
  const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && buttons.length) { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length; buttons[next].focus() }
}
function closeBackgroundActions() { backgroundMenu.value = null }
async function openBackgroundActions(event:MouseEvent) { clearSelection(); closeActions(false); backgroundMenu.value = { x: event.clientX, y: event.clientY }; await nextTick(); const menu = backgroundActionMenu.value; if (!menu || !backgroundMenu.value) return; const rect = menu.getBoundingClientRect(); backgroundMenu.value = { x: Math.max(4, Math.min(backgroundMenu.value.x, window.innerWidth - rect.width - 4)), y: Math.max(4, Math.min(backgroundMenu.value.y, window.innerHeight - rect.height - 4)) }; menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }
function onSurfaceContextMenu(event:MouseEvent) { if ((event.target as HTMLElement).closest('[data-entry-key],button,input,select,a,[role="menu"]')) return; event.preventDefault(); openBackgroundActions(event) }
function clearSelection() { selectedKeys.value = new Set(); selectionAnchor.value = null }

function setSort(key:string) { if (sort.value === key) sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc'; else { sort.value = key; sortDirection.value = key === 'name' ? 'asc' : 'desc' } saveFolderPreferences() }
function sortIndicator(key:string) { return sort.value === key ? (sortDirection.value === 'asc' ? '↑' : '↓') : '' }
function columnStyle(key:keyof ExplorerColumns) { return { width: `${ columns.value[key] }px`, minWidth: `${ columns.value[key] }px` } }
function preferenceContext() { return { collectionId: snapshot.value?.collection.id ?? 'pending', path: section.value === 'files' ? currentPath.value : `@${ section.value }` } }
function loadFolderPreferences() { const context = preferenceContext(); const stored = explorer.loadFolderPreferences(context.collectionId, context.path); sort.value = stored.sort; sortDirection.value = stored.direction; columns.value = stored.columns; view.value = stored.view }
function saveFolderPreferences() { if (!snapshot.value) return; const context = preferenceContext(); explorer.saveFolderPreferences(context.collectionId, context.path, { sort: sort.value, direction: sortDirection.value, columns: columns.value, view: view.value }) }
function captureGestureClick(event:MouseEvent) {
  if (!suppressGestureClick) return;
  event.preventDefault(); event.stopImmediatePropagation(); suppressGestureClick = false;
}
function trackPointer(event:PointerEvent, move:(event:PointerEvent) => void, finish:(cancelled:boolean) => void, didDrag:() => boolean) {
  const onMove = (next:PointerEvent) => { if (next.pointerId === event.pointerId) move(next) };
  const stop = (cancelled = true) => {
    window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onCancel); window.removeEventListener('blur', onBlur);
    stopPointerGesture = undefined;
    if (!cancelled && didDrag()) { suppressGestureClick = true; if (gestureClickTimer) clearTimeout(gestureClickTimer); gestureClickTimer = setTimeout(() => { suppressGestureClick = false }, 0) }
    finish(cancelled);
  };
  const onUp = (next:PointerEvent) => { if (next.pointerId === event.pointerId) stop(false) };
  const onCancel = (next:PointerEvent) => { if (next.pointerId === event.pointerId) stop() };
  const onBlur = () => stop();
  stopPointerGesture = () => stop();
  window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); window.addEventListener('pointercancel', onCancel); window.addEventListener('blur', onBlur);
}
function startColumnResize(key:keyof ExplorerColumns, event:PointerEvent) {
  if (event.button !== 0) return;
  stopPointerGesture?.();
  const startX = event.clientX; const startWidth = columns.value[key];
  trackPointer(event, next => { columns.value = { ...columns.value, [key]: Math.max(72, Math.min(720, startWidth + next.clientX - startX)) } }, cancelled => { if (cancelled) columns.value = { ...columns.value, [key]: startWidth }; else saveFolderPreferences() }, () => true);
}

function startMarquee(event:PointerEvent) {
  if (event.button !== 0 || busy.value || (event.target as HTMLElement).closest('button,input,a,select,thead,[data-entry-key]')) return;
  stopPointerGesture?.(); mainSurface.value?.focus();
  const originX = event.clientX; const originY = event.clientY; const additive = event.metaKey || event.ctrlKey; const existing = new Set(selectedKeys.value);
  let moved = false;
  const move = (next:PointerEvent) => {
    if (!moved && Math.hypot(next.clientX - originX, next.clientY - originY) < 4) return;
    moved = true;
    const left = Math.min(originX, next.clientX); const top = Math.min(originY, next.clientY); const right = Math.max(originX, next.clientX); const bottom = Math.max(originY, next.clientY);
    marquee.value = { left, top, width: right - left, height: bottom - top, additive };
    const hits = visibleEntries.value.filter(entry => { const node = browserSurface.value?.querySelector<HTMLElement>(`[data-entry-key="${ CSS.escape(entry.key) }"]`); if (!node) return false; const rect = node.getBoundingClientRect(); return rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom }).map(entry => entry.key);
    selectedKeys.value = new Set([...(additive ? existing : []), ...hits]);
  };
  trackPointer(event, move, cancelled => { marquee.value = null; if (cancelled) selectedKeys.value = existing; else if (!moved && !additive) clearSelection() }, () => moved || additive); event.preventDefault();
}

async function openQuickLook(entry = selectedEntries.value.find(item => !item.folder)) {
  if (!entry || entry.folder) return;
  if (!quickLookEntry.value) quickLookTrigger = document.activeElement as HTMLElement | null;
  quickLookEntry.value = entry; quickLookUrl.value = ''; quickLookLoading.value = true; const generation = ++quickLookGeneration;
  await nextTick(); if (generation !== quickLookGeneration) return; quickLookDialog.value?.querySelector<HTMLButtonElement>('button')?.focus();
  try { const url = await props.dataSource.mediaUrl(entry.id, entry.currentVersionId); if (generation === quickLookGeneration) quickLookUrl.value = url } catch { if (generation === quickLookGeneration) quickLookUrl.value = '' } finally { if (generation === quickLookGeneration) quickLookLoading.value = false }
}
function closeQuickLook() { const wasOpen = Boolean(quickLookEntry.value); quickLookGeneration++; quickLookEntry.value = null; quickLookUrl.value = ''; quickLookLoading.value = false; if (wasOpen) quickLookTrigger?.focus(); quickLookTrigger = null }
function stepQuickLook(delta:number) { const entry = quickLookEntries.value[quickLookIndex.value + delta]; if (entry) openQuickLook(entry) }

function joinPath(folder:string, name:string) { return [folder.replace(/^\/+|\/+$/g, ''), name].filter(Boolean).join('/') }
function operationItems(entries:DisplayEntry[], destination:string) { return entries.map(entry => operationTarget(toTarget(entry), destination)) }
function operationRequests(action:'move'|'copy',items:OperationItem[],collectionId:string,destinationCollectionId:string):FilesOperationItem[] {
  const crossCollection=collectionId!==destinationCollectionId;
  return items.map(item => item.folderPath ? {
    itemId:crypto.randomUUID(),kind:'folder',action,folderPath:item.folderPath,expectedFolder:item.expectedFolder,targetPath:item.targetPath,
    ...(crossCollection?{targetCollectionId:destinationCollectionId,sourceSubtreeSignature:item.sourceSubtreeSignature}:{}),
  } : {
    itemId:crypto.randomUUID(),kind:'file',action,fileId:item.fileId,expectedVersionId:item.expectedVersionId,
    expectedRevision:item.expectedRevision ?? (crossCollection?undefined:snapshot.value?.files.find(file=>file.id===item.fileId)?.operationRevision),targetPath:item.targetPath,
    ...(crossCollection?{targetCollectionId:destinationCollectionId}:{}),
  });
}
async function perform(action:'move' | 'copy', items:OperationItem[], sourceCollectionId?:string, capturedSourceCapability?:FilesCrossCollectionCapability) {
  if (readOnlyArea.value) return;
  if (busy.value || !snapshot.value || !items.length) return false;
  const destinationCollectionId = snapshot.value.collection.id;
  const destinationPath = currentPath.value;
  const destinationSnapshot = snapshot.value;
  const collectionId = sourceCollectionId ?? destinationCollectionId;
  const crossCollection = collectionId !== destinationCollectionId;
  if (!crossCollection && items.some(item => item.folderPath && (item.targetPath === item.folderPath || item.targetPath.startsWith(item.folderPath + '/')))) { operationError.value = 'A folder cannot be placed inside itself.'; return false }
  if (crossCollection) {
    if (!capturedSourceCapability || capturedSourceCapability === 'unavailable' || props.dataSource.capabilities.crossCollectionOperations === 'unavailable' || !props.dataSource.operationCapabilities) { operationError.value = 'The source or destination does not authorize a receipt-backed transfer.'; return false }
    if (items.some(item => item.folderPath && (!/^[0-9a-f]{64}$/.test(item.sourceSubtreeSignature ?? '') || (item.expectedFolder?.collectionId !== undefined && item.expectedFolder.collectionId !== collectionId)))) { operationError.value = 'Cross-collection folders require the source snapshot captured when the drag or clipboard selection began.'; return false }
    busy.value=true; operationError.value=''; let submitted=false;
    try {
      const [sourceCapabilities,destinationCapabilities]=await Promise.all([props.dataSource.operationCapabilities(collectionId),props.dataSource.operationCapabilities(destinationCollectionId)]);
      if (!mounted || snapshot.value!==destinationSnapshot || snapshot.value.collection.id!==destinationCollectionId || currentPath.value!==destinationPath) { operationError.value='The destination changed before the transfer was submitted, so nothing was moved.'; return false }
      if (!sourceCapabilities.enabled || !destinationCapabilities.enabled || sourceCapabilities.crossCollectionOperations==='unavailable' || destinationCapabilities.crossCollectionOperations==='unavailable') { operationError.value = 'The source or destination does not authorize a receipt-backed transfer.'; return false }
      if (items.some(item=>item.folderPath) && (!sourceCapabilities.folderReceipts || !destinationCapabilities.folderReceipts)) { operationError.value = 'The source or destination does not authorize receipt-backed folder transfers.'; return false }
      if (!operations.supported()) { operationError.value='Cross-collection transfer requires durable operation receipts.'; return false }
      const requests=operationRequests(action,items,collectionId,destinationCollectionId);
      if (pendingRequest.value || operations.receipts.value.some(receipt=>receipt.state==='pending')) { operationError.value='Resolve the pending operation before starting another.'; return false }
      if (requests.length>250) { operationError.value='Select at most 250 items for one operation.'; return false }
      if (requests.some(item=>item.kind!=='folder' && (!item.expectedVersionId || !item.expectedRevision))) { operationError.value='The service did not supply a revision for this item. Refresh Files before trying again.'; return false }
      operationNotice.value=''; submitted=true;
      const receipt=await operations.submit({idempotencyKey:crypto.randomUUID(),collectionId,items:requests});
      return Boolean(receipt && receipt.items.every(item=>item.state==='completed'));
    } catch(cause) { operationError.value=cause instanceof Error?cause.message:String(cause); return false }
    finally { if (submitted && mounted) await refresh(true,true); busy.value=false }
  }
  const receiptSupported = operations.supported() && items.every(item => item.fileId || (item.folderPath && props.dataSource.capabilities.folderReceipts));
  if (receiptSupported) {
    const requests=operationRequests(action,items,collectionId,destinationCollectionId);
    return submitReceiptItems(requests, collectionId);
  }
  operationNotice.value = 'This operation reports completion only. Undo, collision choices, cancellation and retry are unavailable.';
  return runMutation(async() => { await props.dataSource.operate(action, collectionId, items); selectedKeys.value = new Set(); closeActions(false) });
}
async function submitReceiptItems(items:FilesOperationItem[], collectionId = snapshot.value?.collection.id) {
  if (!snapshot.value || pendingRequest.value || operations.receipts.value.some(receipt => receipt.state === 'pending')) { operationError.value = 'Resolve the pending operation before starting another.'; return false }
  if (!collectionId) return false;
  if (items.length > 250) { operationError.value = 'Select at most 250 items for one operation.'; return false }
  if (items.some(item => item.kind !== 'folder' && item.action !== 'create-folder' && (!item.expectedVersionId || !item.expectedRevision))) { operationError.value = 'The service did not supply a revision for this item. Refresh Files before trying again.'; return false }
  let receipt:FilesOperationReceipt | null = null;
  operationNotice.value = '';
  await runMutation(async() => { receipt = await operations.submit({ idempotencyKey: crypto.randomUUID(), collectionId, items }) });
  return Boolean(receipt && (receipt as FilesOperationReceipt).items.every(item => item.state === 'completed'));
}
async function undoLastOperation() {
  if (!canUndo.value || !undoReceipt.value) return;
  const id = undoReceipt.value.operationId;
  await runMutation(async() => { await operations.undo(id) });
}
async function retryReceipt(itemId?:string) {
  const receipt = operationReceipt.value;
  if (!receipt || !props.dataSource.retryOperation || !receiptTouchesCollection(receipt,snapshot.value?.collection.id)) return;
  await runMutation(async() => { await operations.retry(receipt.operationId, itemId ? { items: [{ itemId }] } : undefined) });
}
function receiptTouchesCollection(receipt:FilesOperationReceipt,collectionId?:string):boolean {
  return operations.touchesCollection(receipt, collectionId);
}
function operationItemKind(item:FilesOperationItemReceipt):'file' | 'folder' | undefined {
  const state=item.before ?? item.after;

  if (isFilesOperationState(state)) return 'file';
  if (isFilesFolderState(state)) return 'folder';
}
function replaceCollisionDestination(item:FilesOperationItemReceipt):FilesCollisionDestination | undefined {
  if (item.action === 'create-folder') return;
  const destination=item.error?.destination;
  const sourceKind=operationItemKind(item);

  if (isFilesOperationState(destination)) {
    if (sourceKind && sourceKind !== 'file') return;
    return destination.deleted || (destination.collectionId !== undefined && destination.collectionId !== snapshot.value?.collection.id) ? undefined : destination;
  }
  if (isFilesFolderReplacementDestination(destination)) {
    if (sourceKind && sourceKind !== 'folder') return;
    if (destination.collectionId !== undefined && destination.collectionId !== snapshot.value?.collection.id) return;
    return props.dataSource.capabilities.folderCollisionPolicies?.includes('replace') === true ? destination : undefined;
  }
}
function canReplaceCollisionItem(item:FilesOperationItemReceipt):boolean {
  return Boolean(replaceCollisionDestination(item));
}
async function resolveCollision(policy:FilesCollisionPolicy) {
  const receipt = operationReceipt.value; const selected = collisionItem.value;
  if (!receipt || !selected || !props.dataSource.retryOperation || !receiptTouchesCollection(receipt,snapshot.value?.collection.id)) return;
  const items = collisionItems.value;
  const retryItems:NonNullable<FilesOperationRetry['items']>=[];

  for (const item of items) {
    if (policy === 'replace') {
      const expectedDestination=replaceCollisionDestination(item);

      if (!expectedDestination) { operationError.value = 'Replace requires an authorized, current destination snapshot for every selected conflict. Folder creation supports Keep Both or Skip.'; return }
      retryItems.push({ itemId: item.itemId, collisionPolicy:policy, expectedDestination });
    } else {
      retryItems.push({ itemId: item.itemId, collisionPolicy:policy });
    }
  }
  await runMutation(async() => { await operations.retry(receipt.operationId, { items:retryItems }) });
}
async function recoverOperation() {
  const request = pendingRequest.value; const receipt = operationReceipt.value;
  if (request && request.collectionId !== snapshot.value?.collection.id && !request.items.some(item => item.targetCollectionId === snapshot.value?.collection.id)) { operationError.value = 'Return to a collection involved in the pending operation to recover it.'; return }
  await runMutation(async() => { if (request) await operations.submit(request); else if (receipt) await operations.resume(receipt.operationId) });
}
async function showOperation(operationId:string) { await runMutation(async() => { await operations.resume(operationId) }) }
function beginRename(entry = selectedEntries.value[0]) { if (readOnlyArea.value) return; if (busy.value || section.value === 'trash' || !entry || selectedEntries.value.length > 1) return; editingKey.value = entry.key; renameValue.value = entry.name; nextTick(() => setRenameInput(browserSurface.value?.querySelector<HTMLInputElement>('.inline-rename'), entry)) }
function setRenameInput(element:unknown, entry:DisplayEntry) { if (!(element instanceof HTMLInputElement) || editingKey.value !== entry.key || document.activeElement === element) return; nextTick(() => { if (!element.isConnected || editingKey.value !== entry.key) return; element.focus(); const dot = entry.folder ? -1 : entry.name.lastIndexOf('.'); element.setSelectionRange(0, dot > 0 ? dot : entry.name.length) }) }
function cancelRename() { const key = editingKey.value; editingKey.value = ''; renameValue.value = ''; renameCommitting = false; if (key) nextTick(() => { if (!editingKey.value) browserSurface.value?.querySelector<HTMLElement>(`[data-entry-key="${ CSS.escape(key) }"]`)?.focus() }) }
async function commitRename(entry:DisplayEntry) {
  if (renameCommitting || editingKey.value !== entry.key) return;
  const name = renameValue.value.trim();
  if (!name || name === entry.name) { cancelRename(); return }
  if (name.includes('/') || name === '.' || name === '..') { operationError.value = 'Names can’t contain “/” or be “.” or “..”.'; return }
  renameCommitting = true; const parent = entry.path.split('/').slice(0, -1).join('/'); const success = await perform('move', [{ ...operationTarget(toTarget(entry), parent), targetPath: joinPath(parent, name) }]);
  if (success) cancelRename(); else renameCommitting = false;
}
function renameSelected() { const entry = selectedEntries.value[0]; if (entry && selectedEntries.value.length === 1) beginRename(entry) }
async function moveSelected() { const entries = selectedEntries.value; if (busy.value || loading.value || !entries.length) return; const destination = window.prompt('Move to folder', currentPath.value)?.trim(); if (destination === undefined) return; await perform('move', operationItems(entries, destination)) }
async function copyToClipboard(mode:'copy' | 'cut') {
  if (readOnlyArea.value && mode === 'cut') return;
  if (busy.value || !snapshot.value || !selectedEntries.value.length || section.value === 'trash') return;
  const collectionId=snapshot.value.collection.id; const entries=[...selectedEntries.value]; const sourceCapability=props.dataSource.capabilities.crossCollectionOperations ?? 'unavailable';
  busy.value=true; operationError.value='';
  try { explorer.setClipboard(collectionId,sourceCapability,mode,await Promise.all(entries.map(entry=>captureTarget(entry,collectionId)))) }
  catch(cause) { operationError.value=cause instanceof Error?cause.message:String(cause) }
  finally { busy.value=false }
}
async function pasteClipboard() { if (!snapshot.value || !canPaste.value || !clipboard.value) return; const value = clipboard.value; const success = await perform(value.mode === 'cut' ? 'move' : 'copy', value.targets.map(target => operationTarget(target, currentPath.value)), value.collectionId,value.sourceCapability); if (success && value.mode === 'cut') clipboard.value = null }
function isCut(entry:DisplayEntry) { return clipboard.value?.mode === 'cut' && clipboard.value.collectionId === snapshot.value?.collection.id && clipboard.value.targets.some(target => target.key === entry.key) }
async function downloadSelected() { const entries = selectedEntries.value.filter(entry => !entry.folder); if (!entries.length) return; await runMutation(async() => { const result = await props.dataSource.downloadFiles(entries.map(entry => ({ fileId: entry.id, name: entry.name, versionId: entry.currentVersionId }))); if (result.error) operationError.value = result.error }, false) }
async function trashSelected() {
  if (readOnlyArea.value) return;
  if (busy.value || section.value === 'trash' || !props.dataSource.capabilities.trash) return;
  if (operations.supported() && props.dataSource.capabilities.folderReceipts) {
    const items:FilesOperationItem[] = selectedEntries.value.map(entry => entry.folder ? {
      itemId: crypto.randomUUID(), kind: 'folder', action: 'trash', folderPath: entry.path, expectedFolder: entry.folderState,
    } : {
      itemId: crypto.randomUUID(), kind: 'file', action: 'trash', fileId: entry.id,
      expectedVersionId: entry.currentVersionId, expectedRevision: entry.operationRevision,
    });
    if (items.length) await submitReceiptItems(items);
    return;
  }
  const files = new Map<string, FilesItem>();
  if (selectedEntries.value.some(entry => entry.folder)) operationNotice.value = 'Trash applies to the selected folders’ files. Empty folder metadata is retained; folder Trash is unavailable.';
  for (const entry of selectedEntries.value) { if (!entry.folder) files.set(entry.id, entry); else for (const file of activeFiles.value.filter(file => file.path === entry.path || file.path.startsWith(`${ entry.path }/`))) files.set(file.id, file) }
  if (!files.size) return;
  if (operations.supported() && selectedEntries.value.every(entry => !entry.folder)) {
    await submitReceiptItems([...files.values()].map(file => ({ itemId: crypto.randomUUID(), kind: 'file', action: 'trash', fileId: file.id, expectedVersionId: file.currentVersionId, expectedRevision: file.operationRevision })));
    return;
  }
  await runMutation(async() => { for (const file of files.values()) await props.dataSource.trashFile(file.id); selectedKeys.value = new Set(); closeActions(false) });
}
async function restoreSelected() {
  const entries = selectedEntries.value.filter((entry):entry is DisplayEntry & { trashItem:FilesTrashItem } => Boolean(entry.trashItem));
  const restore = props.dataSource.restoreTrashItem?.bind(props.dataSource);
  if (!entries.length || section.value !== 'trash' || !restore) return;
  await runMutation(async() => {
    let restored = 0; let notAttempted = 0; let pending = [...entries].sort((left, right) => Number(right.trashItem.kind === 'folder') - Number(left.trashItem.kind === 'folder')); const failures:string[] = [];
    while (pending.length) {
      const entry = pending.shift()!;

      try { await restore(entry.trashItem); restored++ }
      catch (cause) {
        failures.push(`${ entry.name }: ${ cause instanceof Error ? cause.message : String(cause) }`);
        if (entry.trashItem.kind === 'folder') { notAttempted = pending.length; break }
        continue;
      }
      if (entry.trashItem.kind === 'folder' && pending.length) {
        try { pending = await authoritativeTrashEntries(pending) }
        catch (cause) { failures.push(`Trash refresh: ${ cause instanceof Error ? cause.message : String(cause) }`); notAttempted = pending.length; break }
      }
    }
    operationNotice.value = restored ? `${ restored } item${ restored === 1 ? '' : 's' } restored from their exact Trash tombstone.` : '';
    operationError.value = [failures.length ? `${ failures.length } item${ failures.length === 1 ? '' : 's' } not restored. ${ failures.join(' · ') }` : '', notAttempted ? `${ notAttempted } remaining item${ notAttempted === 1 ? ' was' : 's were' } retained without an attempt.` : ''].filter(Boolean).join(' ');
    selectedKeys.value = new Set(); closeActions(false);
  });
}
async function onTrashDetailOutcome(message:string) {
  selected.value = null;
  operationError.value = message;
  await refresh(true);
}
async function purgeEntries(entries:DisplayEntry[], all = false) {
  if (busy.value || loading.value || section.value !== 'trash' || !props.dataSource.purgeTrashItem) return;
  const purge = props.dataSource.purgeTrashItem.bind(props.dataSource);
  const items = entries.filter((entry):entry is DisplayEntry & { trashItem:FilesTrashItem } => Boolean(entry.trashItem));
  if (!items.length) return;
  const warning = all ? 'Permanently delete every eligible item? Retention, record locks, changed tombstones, and unapproved disposal will remain.' : `Permanently delete ${ items.length } eligible item${ items.length === 1 ? '' : 's' }? Protected or changed items will remain.`;
  if (!window.confirm(warning)) return;
  await runMutation(async() => {
    let completed = 0; let notAttempted = 0; let pending = [...items].sort((left, right) => Number(right.trashItem.kind === 'folder') - Number(left.trashItem.kind === 'folder')); const recovering:string[] = []; const failures:string[] = [];
    while (pending.length) {
      const entry = pending.shift()!;

      try {
        const result = await purge(entry.trashItem);
        if (result.status === 'purged') completed++;
        else {
          const chunks = 'chunks' in result ? ` chunks ${ result.chunks };` : '';

          recovering.push(`${ entry.name }: ${ result.reason || `metadata removed;${ chunks } retained artifacts ${ result.retainedArtifacts }` }`);
        }
      } catch (cause) {
        failures.push(`${ entry.name }: ${ cause instanceof Error ? cause.message : String(cause) }`);
        if (entry.trashItem.kind === 'folder') { notAttempted = pending.length; break }
        continue;
      }
      if (entry.trashItem.kind === 'folder' && pending.length) {
        try { pending = await authoritativeTrashEntries(pending) }
        catch (cause) { failures.push(`Trash refresh: ${ cause instanceof Error ? cause.message : String(cause) }`); notAttempted = pending.length; break }
      }
    }
    operationNotice.value = completed ? `${ completed } item${ completed === 1 ? '' : 's' } fully disposed.` : '';
    operationError.value = [recovering.length ? `${ recovering.length } item${ recovering.length === 1 ? '' : 's' } require cleanup recovery: ${ recovering.join(' · ') }` : '', failures.length ? `${ failures.length } item${ failures.length === 1 ? '' : 's' } retained: ${ failures.join(' · ') }` : '', notAttempted ? `${ notAttempted } remaining item${ notAttempted === 1 ? ' was' : 's were' } retained without an attempt.` : ''].filter(Boolean).join(' ');
    selectedKeys.value = new Set();
  });
}
async function authoritativeTrashEntries(pending:(DisplayEntry & { trashItem:FilesTrashItem })[]):Promise<(DisplayEntry & { trashItem:FilesTrashItem })[]> {
  const loaded = await props.dataSource.load();
  const authoritative = new Map((loaded.trash ?? []).map(item => [`${ item.kind }:${ item.id }`, item]));

  snapshot.value = loaded;
  return pending.filter(entry => authoritative.has(`${ entry.trashItem.kind }:${ entry.trashItem.id }`));
}
function purgeSelected() { return purgeEntries(selectedEntries.value) }
function emptyTrash() { return purgeEntries(trashItems.value.map(toTrashDisplay), true) }
async function runTargetAction(action:'open' | 'native-open' | 'reveal' | 'reference' | 'details' | 'share' | 'rename' | 'move' | 'copy' | 'cut' | 'download' | 'online-only' | 'keep-local' | 'trash' | 'restore' | 'purge') {
  const target = actionTarget.value; if (!target || busy.value || loading.value) return; closeActions();
  if (action === 'open') { activate(target); return }
  if (action === 'native-open') { await activate(target); return }
  if (action === 'reveal') {
    if (!props.dataSource.capabilities.nativeReveal || !props.dataSource.revealFile) return;
    try {
      const result = await props.dataSource.revealFile(target.id, target.currentVersionId);

      if (result.status === 'unavailable') operationError.value = result.reason;
    } catch (cause) { operationError.value = cause instanceof Error ? cause.message : String(cause) }
    return;
  }
  if (action === 'reference') { try { const params = new URLSearchParams({ version: target.currentVersionId, path: target.path, name: target.name }); await navigator.clipboard.writeText(`sulla-file://${ target.id }?${ params }`) } catch (cause) { operationError.value = cause instanceof Error ? cause.message : String(cause) } return }
  if (action === 'details') { await showDetails(target); return }
  if (action === 'share') {
    if (target.folder && snapshot.value) shareTarget.value = { id: target.id, name: target.name, folder: true, path: target.path, collectionId: snapshot.value.collection.id, orgId: snapshot.value.collection.orgId, ownerUserId: snapshot.value.collection.ownerUserId };
    else shareEntry(target);
    return;
  }
  if (['rename', 'online-only', 'keep-local', 'restore', 'purge'].includes(action)) selectedKeys.value = new Set([target.key]);
  if (action === 'rename') renameSelected(); else if (action === 'move') await moveSelected(); else if (action === 'copy' || action === 'cut') copyToClipboard(action); else if (action === 'download') await downloadSelected();
  else if (action === 'restore') await restoreSelected(); else if (action === 'purge') await purgeSelected();
  else if (action === 'online-only' || action === 'keep-local') { const operation = action === 'online-only' ? props.dataSource.makeOnlineOnly : props.dataSource.keepOnMac; if (!operation) return; await runMutation(() => operation.call(props.dataSource, target.id)) }
  else await trashSelected();
}
function trackUpload(progress:{ current: number; name: string; percent: number; done: boolean }) { const log = progress.current <= 1 && !uploadLog.value.some(item => item.name === progress.name) ? [] : uploadLog.value.map(item => item.name === progress.name ? item : { ...item, done: true, percent: 100 }); const rest = log.filter(item => item.name !== progress.name); uploadLog.value = [...rest, { name: progress.name, percent: progress.percent, done: progress.done || progress.percent >= 100 }] }
function closeMenuOnResize() { closeActions(false); closeBackgroundActions(); stopPointerGesture?.() }
function onKeydown(event:KeyboardEvent) {
  if (!quickLookDialog.value?.contains(event.target as Node) && !browserSurface.value?.contains(event.target as Node) && !actionMenu.value?.contains(event.target as Node) && !backgroundActionMenu.value?.contains(event.target as Node)) return;
  const target = event.target as HTMLElement | null; const editable = target?.matches('input,textarea,select,[contenteditable="true"]'); const modifier = event.metaKey || event.ctrlKey; const key = event.key.toLowerCase();
  if (editable) { if (event.key === 'Escape') (target as HTMLElement).blur(); return }
  if (quickLookEntry.value) {
    if (event.key === 'Tab') { const controls = [...(quickLookDialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled),video,audio,iframe') ?? [])]; const index = controls.indexOf(document.activeElement as HTMLElement); if (controls.length) { event.preventDefault(); controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus() } }
    else if (event.key === 'Escape' || (event.key === ' ' && !target?.closest('button,video,audio'))) { event.preventDefault(); closeQuickLook() }
    else if (!target?.closest('video,audio') && event.key === 'ArrowLeft') { event.preventDefault(); stepQuickLook(-1) }
    else if (!target?.closest('video,audio') && event.key === 'ArrowRight') { event.preventDefault(); stepQuickLook(1) }
    return;
  }
  if (event.repeat && (event.key === 'Delete' || event.key === 'Backspace')) { event.preventDefault(); return }
  if (selected.value || shareTarget.value || folderDetails.value || target?.closest('button,a,dialog')) return;
  if (event.key === 'Escape') { cancelRename(); closeActions(false); closeBackgroundActions(); clearSelection(); return }
  if (modifier && key === 'k') { event.preventDefault(); searchInput.value?.focus(); return }
  if (modifier && key === 'z' && !event.shiftKey) { event.preventDefault(); undoLastOperation(); return }
  if (modifier && key === 'a' && !selected.value) { event.preventDefault(); selectedKeys.value = new Set(visibleEntries.value.map(entry => entry.key)); return }
  if (modifier && key === 'c' && selectedEntries.value.length) { event.preventDefault(); copyToClipboard('copy'); return }
  if (modifier && key === 'x' && selectedEntries.value.length) { event.preventDefault(); copyToClipboard('cut'); return }
  if (modifier && key === 'v' && canPaste.value) { event.preventDefault(); pasteClipboard(); return }
  if (modifier && event.key === 'ArrowUp' && section.value === 'files') { event.preventDefault(); openParent(); return }
  if ((event.key === 'Delete' || (event.metaKey && event.key === 'Backspace')) && selectedEntries.value.length && section.value !== 'trash') { event.preventDefault(); trashSelected(); return }
  if (event.key === ' ' && selectedEntries.value.some(entry => !entry.folder)) { event.preventDefault(); openQuickLook(); return }
}
function navigateTo(detail:FilesNavigationPayload) {
  if (detail.section === 'shared-by-me') { selectSection('sharedByMe'); return }
  const file = snapshot.value?.files.find(item => item.id === detail.fileId) ?? snapshot.value?.files.find(item => item.path === detail.path);
  if (!file && detail.path) {
    openPath(detail.path);
    if (detail.section === 'share-review') shareCurrentFolder();
    return;
  }
  if (!file) { error.value = 'That file is no longer available in this collection.'; return }
  selectEntry(toDisplay(file));
  if (detail.section === 'versions') detailTab.value = 'versions';
  if (detail.section === 'share-review') shareEntry(toDisplay(file));
}

watch(view, () => { stopPointerGesture?.(); saveFolderPreferences() });
let searchTimer:ReturnType<typeof setTimeout> | undefined;
let searchGeneration = 0;
let mounted = false;
watch([() => props.dataSource, () => snapshot.value?.collection.id, section, currentPath, query, busy], invalidateDragPreparation, { flush:'sync' });
watch([selectedKeys, visibleEntries], () => {
  const preparation=dragPreparation;
  if (!preparation) return;
  const anchor=visibleEntries.value.find(entry=>entry.key===preparation.anchorKey);
  if (!anchor || dragSelectionSignature(dragEntriesFor(anchor),preparation.collectionId)!==preparation.signature) invalidateDragPreparation();
}, { flush:'sync' });
onBeforeUnmount(invalidateDragPreparation);
watch([query, section, busy], ([value, requestedSection, mutating]) => {
  const generation = ++searchGeneration;
  if (searchTimer) clearTimeout(searchTimer);
  searchResults.value = null;
  searchCoverage.value = null;
  if (mutating || !value.trim() || requestedSection === 'trash') return;
  const collectionId = snapshot.value?.collection.id;
  const isCurrent = () => mounted && !busy.value && collectionId === snapshot.value?.collection.id && generation === searchGeneration && query.value === value && section.value === requestedSection;
  searchTimer = setTimeout(async() => {
    try {
      const result = await props.dataSource.search(value.trim());
      if (isCurrent()) { searchResults.value = result.files; searchCoverage.value = result.coverage }
    } catch (cause) {
      if (isCurrent()) error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }, 220);
});
function consumeNavigation() { if (!mounted || busy.value || loading.value || !props.navigation || !snapshot.value) return; navigateTo(props.navigation); emit('navigation-consumed') }
watch(busy, value => { if (!value) consumeNavigation() });
watch(() => props.navigation, () => consumeNavigation());
let stopUploadProgress:(() => void) | undefined;
let stopCapabilitiesChanged:(() => void) | undefined;
let uploadDismissTimer:ReturnType<typeof setTimeout> | undefined;
onMounted(async() => { mounted = true; window.addEventListener('click', captureGestureClick, true); window.addEventListener('keydown', onKeydown); window.addEventListener('pointerdown', dismissActions); window.addEventListener('resize', closeMenuOnResize); window.addEventListener('dragover', updateDragPointer); stopCapabilitiesChanged = props.dataSource.onCapabilitiesChanged?.(() => triggerRef(snapshot)); stopUploadProgress = props.dataSource.onUploadProgress?.((progress) => { if (uploadDismissTimer) clearTimeout(uploadDismissTimer); trackUpload(progress); uploadProgress.value = progress; if (progress.done) uploadDismissTimer = setTimeout(() => { uploadProgress.value = null; uploadLog.value = [] }, 2200); }); await refresh(); if (!mounted) return; explorer.clearForCollection(snapshot.value?.collection.id ?? ''); loadFolderPreferences(); consumeNavigation(); refreshTimer = setInterval(async() => { if (busy.value || loading.value) return; await refresh(true); consumeNavigation() }, 12_000) });
onBeforeUnmount(() => { mounted = false; refreshGeneration++; searchGeneration++; quickLookGeneration++; stopPointerGesture?.(); cancelHoverOpen(); if (searchTimer) clearTimeout(searchTimer); if (gestureClickTimer) clearTimeout(gestureClickTimer); if (uploadDismissTimer) clearTimeout(uploadDismissTimer); window.removeEventListener('click', captureGestureClick, true); window.removeEventListener('keydown', onKeydown); window.removeEventListener('pointerdown', dismissActions); window.removeEventListener('resize', closeMenuOnResize); window.removeEventListener('dragover', updateDragPointer); stopCapabilitiesChanged?.(); stopUploadProgress?.(); if (refreshTimer) clearInterval(refreshTimer); });
</script>

<style scoped>
/* The approved Files palette is local to this surface, independent of the app theme. */
.files-browser {
  --text: #1a2332;
  --muted: #5b6778;
  --dim: #8a94a3;
  --paper: #f4f7fb;
  --paper-2: #eaf0f6;
  --card: rgba(255,255,255,.82);
  --card-solid: #ffffff;
  --line: rgba(26,35,50,.09);
  --line-2: rgba(26,35,50,.14);
  --accent: #3a7fa0;
  --accent-2: #2f6a86;
  --accent-soft: rgba(58,127,160,.10);
  --accent-line: rgba(58,127,160,.32);
  --ok: #1f9d55;
  --ok-soft: rgba(31,157,85,.12);
  --warn: #d98a0a;
  --warn-soft: rgba(217,138,10,.13);
  --bad: #d9403a;
  --bad-soft: rgba(217,64,58,.11);
  --idle: #8a94a3;
  --idle-soft: rgba(138,148,163,.16);
  --ink-05: rgba(26, 35, 50, .05);
  --ink-08: rgba(26, 35, 50, .08);
  --nav-bg: rgba(255, 255, 255, .55);
  --top-bg: rgba(255, 255, 255, .4);
  --glow-1: rgba(58, 127, 160, .10);
  --glow-2: rgba(58, 127, 160, .06);
  --fi-img: #6b4fbf; --fi-img-bg: rgba(107, 79, 191, .12);
  --fi-vid: #c0392b; --fi-vid-bg: rgba(217, 64, 58, .10);
  --fi-pdf: #b26f05; --fi-pdf-bg: rgba(217, 138, 10, .13);
  --fi-aud: #167a42; --fi-aud-bg: rgba(31, 157, 85, .12);
  --shadow: 0 1px 2px rgba(26, 35, 50, .04), 0 10px 30px -12px rgba(26, 35, 50, .12);
  --shadow-sm: 0 1px 1px rgba(26, 35, 50, .04), 0 2px 8px -2px rgba(26, 35, 50, .08);
  --shadow-lg: 0 2px 4px rgba(26, 35, 50, .06), 0 30px 60px -20px rgba(26, 35, 50, .28);
  --sans: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
  --r: 12px;

  position: relative;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  height: 100%;
  min-height: 0;
  overflow: hidden;
  container-type: inline-size;
  font-family: var(--sans);
  color: var(--text);
  background: var(--paper);
  background-image: radial-gradient(900px 500px at 15% -10%, var(--glow-1), transparent 60%), radial-gradient(700px 400px at 100% 0%, var(--glow-2), transparent 55%);
  font-size: 13px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
  font-feature-settings: "tnum" 1, "cv11" 1;
}
.selection-slot { height:52px; margin-bottom:12px; overflow-x:auto; }
.selection-bar { height:40px; box-sizing:border-box; white-space:nowrap; width:max-content; min-width:100%; display:flex; align-items:center; gap:8px; margin:0 0 12px; padding:8px 10px; border:1px solid var(--accent-line); border-radius:8px; background:var(--accent-soft); }
.selection-bar b { margin-right:auto; font-size:12px; }
.operation-error { display:flex; align-items:center; gap:8px; margin:0 0 12px; padding:9px 11px; border:1px solid color-mix(in srgb, var(--bad) 40%, transparent); border-radius:8px; background:var(--bad-soft); color:var(--bad); }
.operation-error.index-complete { border-color:color-mix(in srgb, var(--ok) 35%, transparent); background:var(--ok-soft); color:var(--ok); }
.operation-error .btn { margin-left:auto; }
.operation-panel { display:flex; align-items:center; gap:8px; margin:0 0 12px; padding:10px 12px; border:1px solid var(--accent-line); border-radius:8px; background:var(--accent-soft); }
.operation-panel>div { min-width:180px; flex:1; display:grid; gap:3px; }
.operation-panel b, .operation-panel span { display:block; }
.operation-panel span { color:var(--muted); font-size:11.5px; }
.operation-panel progress { width:min(360px,100%); height:5px; accent-color:var(--accent); }
.operation-queue { align-items:flex-start; flex-wrap:wrap; }
.operation-queue ul { margin:6px 0 0; padding:0; list-style:none; max-height:180px; overflow:auto; }
.operation-queue li { display:flex; align-items:center; gap:8px; padding:3px 0; }
.collision-panel { border-color:color-mix(in srgb, var(--warn) 40%, transparent); background:var(--warn-soft); }
.collision-panel label { display:flex; align-items:center; gap:5px; white-space:nowrap; color:var(--muted); font-size:11.5px; }
.action-menu { --text:#1a2332; --line-2:rgba(26,35,50,.14); --card-solid:#fff; --ink-05:rgba(26,35,50,.05); --bad:#d9403a; --shadow-lg:0 12px 36px rgba(26,35,50,.2); font:13px system-ui,sans-serif; color:var(--text); box-sizing:border-box; max-width:calc(100vw - 8px); max-height:calc(100vh - 8px); overflow:auto; position:fixed; z-index:1000; width:190px; padding:6px; border:1px solid var(--line-2); border-radius:10px; background:var(--card-solid); box-shadow:var(--shadow-lg); }
.action-menu b { display:block; padding:7px 9px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.action-menu button { display:block; width:100%; padding:7px 9px; border:0; border-radius:6px; background:transparent; color:var(--text); text-align:left; }
.action-menu button:hover { background:var(--ink-05); }
.action-menu button.danger { color:var(--bad); }
.history-controls { min-width:0; display:flex; align-items:center; gap:6px; }
.history-controls h1 { margin-left:2px; }
.folder-up.forward span { display:inline-flex; transform:rotate(180deg); }
.folder-up:disabled { opacity:.35; cursor:default; }
.row.is-cut, .tile.is-cut { opacity:.48; }
.inline-rename { width:100%; min-width:80px; padding:2px 5px; border:1px solid var(--accent); border-radius:4px; outline:2px solid var(--accent-soft); background:var(--card-solid); }
.tbl th { position:relative; user-select:none; }
.sort-arrow { color:var(--accent); font-size:11px; }
.resize-handle { position:absolute; z-index:2; top:0; right:-4px; width:8px; height:100%; cursor:col-resize; }
.marquee { position:fixed; z-index:900; pointer-events:none; border:1px solid var(--accent); background:var(--accent-soft); }
.drag-count { position:fixed; z-index:1200; display:grid; place-items:center; min-width:24px; height:24px; padding:0 7px; border-radius:999px; background:var(--accent); color:#fff; box-shadow:var(--shadow-sm); font-weight:700; pointer-events:none; }
.quick-look { position:fixed; z-index:1400; inset:0; display:grid; grid-template-columns:minmax(44px,1fr) minmax(320px,900px) minmax(44px,1fr); place-items:center; padding:48px; background:rgba(10,16,25,.76); backdrop-filter:blur(18px); font:13px var(--sans, system-ui); color:#fff; }
.quick-look-close { position:absolute; top:18px; right:18px; width:36px; height:36px; display:grid; place-items:center; border:0; border-radius:999px; background:rgba(255,255,255,.14); color:#fff; }
.quick-look-close :deep(svg) { width:20px; height:20px; }
.quick-look-card { grid-column:2; width:100%; max-height:calc(100vh - 96px); display:flex; flex-direction:column; overflow:hidden; border:1px solid rgba(255,255,255,.18); border-radius:14px; background:#101722; box-shadow:0 30px 100px rgba(0,0,0,.5); }
.quick-look-card img, .quick-look-card video, .quick-look-card iframe { width:100%; min-height:280px; max-height:calc(100vh - 180px); object-fit:contain; border:0; background:#0a1018; }
.quick-look-card audio { width:calc(100% - 48px); margin:80px 24px; }
.quick-look-card footer { display:flex; justify-content:space-between; gap:20px; padding:13px 16px; color:rgba(255,255,255,.7); }
.quick-look-card footer b { color:#fff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.quick-look-fallback { min-height:340px; display:grid; place-items:center; align-content:center; gap:18px; color:rgba(255,255,255,.65); }
.quick-look-fallback .fi { width:84px; height:84px; }
.quick-look-nav { width:44px; height:64px; border:0; border-radius:10px; background:rgba(255,255,255,.1); color:#fff; font-size:38px; }
.quick-look-nav:disabled { opacity:.2; }
.quick-look-nav.previous { grid-column:1; justify-self:end; margin-right:18px; }
.quick-look-nav.next { grid-column:3; justify-self:start; margin-left:18px; }

.files-browser *, .files-browser *::before, .files-browser *::after { box-sizing: border-box; }
.files-browser a { color: inherit; text-decoration: none; }
.files-browser button { font: inherit; color: inherit; cursor: pointer; }
.files-browser input { font: inherit; color: inherit; }

/* Sidebar */
.nav { position: relative; width: 224px; height: 100%; min-height: 0; overflow-y: auto; padding: 18px 14px; border-right: 1px solid var(--line); background: var(--nav-bg); backdrop-filter: blur(14px); display: flex; flex-direction: column; gap: 4px; }
.brand { display: flex; align-items: center; gap: 10px; padding: 4px 8px 16px; }
.brand .mark { width: 28px; height: 28px; border-radius: 8px; background: linear-gradient(135deg, #3a7fa0, #1a2332); display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 13px; letter-spacing: .02em; flex: none; }
.brand b { display: block; font-size: 13px; letter-spacing: .01em; }
.brand span { display: block; font-size: 11px; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 150px; }
.root-picker { display: grid; gap: 4px; margin: 0 8px 10px; color: var(--dim); font-size: 10.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
.root-picker select { min-width: 0; width: 100%; padding: 6px 8px; border: 1px solid var(--line-2); border-radius: 7px; background: var(--card-solid); color: var(--text); font-size: 12px; font-weight: 500; letter-spacing: 0; text-transform: none; }
.tree-roots { display:grid; gap:2px; margin-bottom:8px; }
.tree-roots button { display:flex; align-items:center; gap:9px; width:100%; padding:7px 14px; border:0; border-radius:7px; background:transparent; color:var(--dim); text-align:left; }
.tree-roots button:hover,.tree-roots button.on { background:var(--ink-05); color:var(--text); }
.collection-drops { display: grid; gap: 4px; margin: 0 8px 10px; }
.collection-drops .btn { width: 100%; white-space: normal; }
.nav a { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 9px; color: var(--muted); font-weight: 500; }
.nav a .sv { display: grid; width: 16px; height: 16px; flex: none; opacity: .8; }
.nav a .sv :deep(svg) { width: 16px; height: 16px; }
.nav a:hover { background: var(--ink-05); color: var(--text); }
.nav a.on { background: var(--accent-soft); color: var(--accent-2); font-weight: 600; }
.nav a.on .sv { opacity: 1; }
.nav a .cnt { margin-left: auto; font-size: 11px; font-weight: 600; background: var(--paper-2); color: var(--muted); padding: 1px 7px; border-radius: 999px; }
.nav a .cnt.warn { background: var(--warn-soft); color: var(--warn); }
.nav .sep { height: 1px; background: var(--line); margin: 10px 8px; }
.nav .grp { font-size: 10.5px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); padding: 8px 10px 4px; }
.nav .favorites { min-height: 44px; padding: 3px; border: 1px dashed transparent; border-radius: 10px; transition: background .15s, border-color .15s; }
.nav .favorites.drop-target { background: var(--accent-soft); border-color: var(--accent-line); }
.nav .favorites-heading { display: flex; align-items: center; justify-content: space-between; }
.nav .favorites-heading span { font-size: 9px; font-weight: 500; letter-spacing: 0; text-transform: none; opacity: .75; }
.nav .favorite-row { display: flex; align-items: center; min-width: 0; }
.nav .favorite-link { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; padding: 7px; border: 0; border-radius: 9px; background: transparent; color: var(--muted); text-align: left; }
.nav .favorite-link:hover:not(:disabled) { background: var(--ink-05); color: var(--text); }
.nav .favorite-link.on { background: var(--accent-soft); color: var(--accent-2); font-weight: 600; }
.nav .favorite-link .sv { display: grid; width: 16px; height: 16px; flex: none; opacity: .8; }
.nav .favorite-link .sv :deep(svg) { width: 16px; height: 16px; }
.nav .favorite-link > span:nth-child(2) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav .favorite-link small { margin-left: auto; color: var(--dim); font-size: 9px; }
.nav .favorite-row.unavailable .favorite-link { opacity: .62; }
.nav .favorite-remove { width: 24px; height: 28px; flex: none; border: 0; border-radius: 6px; background: transparent; color: var(--dim); font-size: 18px; line-height: 1; opacity: 0; }
.nav .favorite-row:hover .favorite-remove, .nav .favorite-remove:focus-visible { opacity: 1; }
.nav .favorite-remove:hover:not(:disabled) { background: var(--ink-05); color: var(--text); }
.nav .quota { padding: 10px 10px 6px; font-size: 11px; color: var(--muted); }
.nav .quota .bar { height: 4px; border-radius: 2px; background: var(--paper-2); overflow: hidden; margin: 6px 0 4px; }
.nav .quota .bar i { display: block; height: 100%; background: var(--accent); border-radius: 2px; }
.nav .quota b { color: var(--text); font-weight: 600; }
.nav .quota > span { display: block; }
.nav .quota.nobar > span { margin-top: 4px; }
.syncline { display: flex; align-items: center; gap: 7px; padding: 8px 10px; font-size: 11.5px; color: var(--muted); border-radius: 9px; background: rgba(255, 255, 255, .6); border: 1px solid var(--line); margin-top: 8px; text-align: left; }
.syncline .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); flex: none; }
.syncline .dot.syncing { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.syncline .dot.paused { background: var(--warn); box-shadow: 0 0 0 3px var(--warn-soft); }
.syncline .dot.error, .syncline .dot.conflict { background: var(--bad); box-shadow: 0 0 0 3px var(--bad-soft); }
.nav .foot { margin-top: auto; padding: 10px 8px 0; border-top: 1px solid var(--line); display: flex; align-items: center; gap: 10px; }
.nav .foot b { display: block; font-size: 12px; }
.nav .foot small { display: block; color: var(--dim); font-size: 11px; }
.avatar { width: 26px; height: 26px; border-radius: 50%; background: linear-gradient(135deg, #9ec1d3, #3a7fa0); color: #fff; font-size: 11px; font-weight: 700; display: grid; place-items: center; flex: none; object-fit: cover; }
.avatar.m { background: linear-gradient(135deg, #f0c38e, #d98a0a); }
.avatar.d { background: linear-gradient(135deg, #b7a7e0, #6b4fbf); }
.avatar.p { background: linear-gradient(135deg, #9ad7b4, #1f9d55); }
.avatar.a { background: linear-gradient(135deg, #1a2332, #3a7fa0); }
.avatar.sm { width: 20px; height: 20px; font-size: 9px; }

/* Top bar */
.main { min-width: 0; min-height: 0; overflow: auto; }
.top { display: flex; align-items: center; gap: 14px; padding: 12px 28px; border-bottom: 1px solid var(--line); background: var(--top-bg); backdrop-filter: blur(10px); position: sticky; top: 0; z-index: 5; }
.crumbs { display: flex; align-items: center; gap: 6px; color: var(--dim); font-size: 12.5px; white-space: nowrap; }
.crumbs b { color: var(--text); font-weight: 600; }
.crumbs .c { color: var(--muted); }
.crumbs .c:hover { color: var(--accent-2); }
.top .search { display: flex; align-items: center; gap: 8px; flex: 1; max-width: 560px; padding: 6px 10px; border: 1px solid var(--line-2); border-radius: 9px; background: var(--card-solid); color: var(--dim); font-size: 12.5px; min-width: 0; }
.top .search .si { display: grid; width: 14px; height: 14px; flex: none; }
.top .search .si :deep(svg) { width: 14px; height: 14px; }
.top .search input { border: 0; outline: 0; background: transparent; flex: 1; min-width: 0; color: var(--text); padding: 0; }
.top .search input::placeholder { color: var(--dim); }
.top .search kbd { font-family: var(--mono); font-size: 10.5px; border: 1px solid var(--line-2); border-radius: 5px; padding: 1px 5px; color: var(--dim); background: var(--paper); }
.top .acts { margin-left: auto; display: flex; gap: 8px; align-items: center; }

/* Buttons and controls */
.btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 11px; border-radius: 8px; border: 1px solid var(--line-2); background: var(--card-solid); font-size: 12.5px; font-weight: 500; color: var(--text); box-shadow: 0 1px 1px rgba(26, 35, 50, .03); white-space: nowrap; line-height: 1.45; }
.btn:hover { border-color: var(--accent-line); color: var(--accent-2); }
.btn.pri { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn.pri:hover { background: var(--accent-2); color: #fff; }
.btn.danger { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 35%, transparent); }
.btn.danger:hover { background: var(--bad-soft); }
.btn.sm { padding: 3px 8px; font-size: 11.5px; border-radius: 6px; }
.btn.ghost { background: transparent; border-color: transparent; box-shadow: none; color: var(--muted); }
.btn.ghost:hover { background: var(--ink-05); color: var(--text); }
.btn .bi { display: grid; width: 13px; height: 13px; flex: none; }
.btn .bi :deep(svg) { width: 13px; height: 13px; }
.btn.ico { padding: 6px; width: 30px; height: 30px; justify-content: center; }
.btn:disabled { cursor: not-allowed; opacity: .55; }
.btn[aria-disabled="true"] { cursor: default; }
.seg { display: inline-flex; border: 1px solid var(--line-2); border-radius: 8px; background: var(--card-solid); padding: 2px; gap: 2px; }
.seg button { border: 0; background: transparent; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 500; color: var(--muted); display: inline-flex; align-items: center; gap: 6px; line-height: 1.45; }
.seg button .bi { display: grid; width: 13px; height: 13px; }
.seg button .bi :deep(svg) { width: 13px; height: 13px; }
.seg button.on { background: var(--accent-soft); color: var(--accent-2); font-weight: 600; }
.seg button:hover:not(.on) { color: var(--text); }
.sel { position: relative; display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border: 1px solid var(--line-2); border-radius: 8px; background: var(--card-solid); font-size: 12px; font-weight: 500; color: var(--text); white-space: nowrap; cursor: pointer; }
.sel > span { color: var(--dim); font-weight: 400; }
.sel::after { content: ""; width: 6px; height: 6px; border-right: 1.5px solid var(--dim); border-bottom: 1.5px solid var(--dim); transform: rotate(45deg) translateY(-2px); }
.sel select { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; font-size: 12px; }
.pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; }
.pill.idle { background: var(--idle-soft); color: var(--muted); }

/* Page header + filters */
.content { padding: 20px 28px 60px; }
.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.toolbar h1 { font-size: 20px; font-weight: 650; letter-spacing: -.01em; margin: 0; font-family: var(--sans); color: var(--text); }
.folder-up { width: 30px; height: 30px; flex: none; display: grid; place-items: center; padding: 0; border: 1px solid var(--line-2); border-radius: 8px; background: var(--card-solid); color: var(--muted); }
.folder-up:hover { border-color: var(--accent-line); color: var(--accent-2); }
.folder-up span { display: grid; width: 18px; height: 18px; }
.folder-up span :deep(svg) { width: 18px; height: 18px; }
.toolbar .meta { color: var(--dim); font-size: 12px; }
.toolbar .right { margin-left: auto; display: flex; gap: 8px; align-items: center; }
.filters { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
.filters .sel.active { border-color: var(--accent-line); background: var(--accent-soft); color: var(--accent-2); }
.filters .sel.active > span { color: var(--accent-2); }
.filters .clear { font-size: 12px; color: var(--muted); padding: 5px 8px; border-radius: 7px; border: 0; background: transparent; }
.filters .clear:hover { color: var(--text); background: var(--ink-05); }
.filters .view { margin-left: auto; display: flex; gap: 8px; align-items: center; }

/* List view */
.card { background: var(--card); backdrop-filter: blur(12px); border: 1px solid var(--line); border-radius: var(--r); box-shadow: var(--shadow); }
.files { overflow: hidden; }
.tbl { width: 100%; border-collapse: collapse; }
.tbl th { font-size: 10.5px; text-transform: uppercase; letter-spacing: .07em; color: var(--dim); font-weight: 600; text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.tbl td { padding: 8px 12px; border-bottom: 1px solid var(--line); vertical-align: middle; }
.tbl tr:last-child td { border-bottom: 0; }
.tbl td.r, .tbl th.r { text-align: right; }
.files .tbl th:first-child, .files .tbl td:first-child { padding-left: 16px; }
.files .tbl th:last-child, .files .tbl td:last-child { padding-right: 14px; }
.muted { color: var(--muted); }
.files tr.row { cursor: default; }
.files tr.row[draggable="true"] { cursor: grab; }
.files tr.row.is-dragging { opacity: .45; }
.files tr.row:hover td { background: color-mix(in srgb, var(--accent) 4.5%, transparent); }
.files tr.row.is-sel td { background: var(--accent-soft); }
.files tr.row.drop-target td { background: var(--accent-soft); }
.files tr.row.drop-target td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
tr.row.agent td { background: rgba(26, 35, 50, .025); }
.tbl tr.sechead td { padding: 10px 16px 4px; border-bottom: 0; font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); font-weight: 600; }
.tbl tr.sechead:not(:first-child) td { padding-top: 14px; }
.files .name { display: flex; align-items: center; gap: 10px; min-width: 0; }
.files .name .t { min-width: 0; }
.files .name .t b { display: block; font-weight: 500; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.files .name .t small { display: block; color: var(--dim); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.files .own { display: flex; align-items: center; gap: 7px; white-space: nowrap; color: var(--muted); }
.files .actions { display: flex; gap: 4px; justify-content: flex-end; opacity: 0; transition: opacity .12s; }
.files tr.row:hover .actions, .files tr.row.is-sel .actions, .files .actions.keep { opacity: 1; }
.files .actions .btn.ico { width: 26px; height: 26px; padding: 4px; border-color: transparent; box-shadow: none; background: transparent; color: var(--muted); }
.files .actions .btn.ico:hover { background: rgba(26, 35, 50, .06); color: var(--text); }
.files .actions .btn.ico :deep(svg) { width: 14px; height: 14px; }
.files .actions .btn.ico :deep(.star) { display: grid; width: 14px; height: 14px; }
.chk { width: 14px; height: 14px; padding: 0; border: 1.5px solid var(--line-2); border-radius: 4px; background: var(--card-solid); display: inline-block; vertical-align: middle; position: relative; }
.chk.on { background: var(--accent); border-color: var(--accent); }
.chk.on::after { content: ""; position: absolute; left: 3.5px; top: .5px; width: 4px; height: 7px; border-right: 2px solid #fff; border-bottom: 2px solid #fff; transform: rotate(45deg); }
:deep(.star) { color: var(--dim); }
:deep(.star.on) { color: var(--warn); }

/* File glyphs */
.fi { width: 30px; height: 30px; border-radius: 7px; display: grid; place-items: center; flex: none; position: relative; }
.fi :deep(svg) { width: 17px; height: 17px; }
.fi.folder { background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent-2); }
.fi.folder.agent, .fi.code { background: var(--ink-08); color: var(--text); }
.fi.img { background: var(--fi-img-bg); color: var(--fi-img); }
.fi.vid { background: var(--fi-vid-bg); color: var(--fi-vid); }
.fi.pdf { background: var(--fi-pdf-bg); color: var(--fi-pdf); }
.fi.doc { background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent-2); }
.fi.aud { background: var(--fi-aud-bg); color: var(--fi-aud); }
.fi.zip { background: var(--idle-soft); color: var(--muted); }

/* Sync state */
.sync { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; }
.sync :deep(svg) { width: 14px; height: 14px; }
.sync.local { color: var(--ok); }
.sync.online { color: var(--dim); }
.sync.syncing { color: var(--accent); }
.sync.syncing :deep(svg) { animation: spin 1.6s linear infinite; }
.sync.conflict { color: var(--bad); }

/* Grid view */
.gridv { display: grid; grid-template-columns: repeat(auto-fill, minmax(188px, 1fr)); gap: 14px; }
.tile { background: var(--card); backdrop-filter: blur(12px); border: 1px solid var(--line); border-radius: var(--r); box-shadow: var(--shadow-sm); overflow: hidden; position: relative; cursor: default; }
.tile[draggable="true"] { cursor: grab; }
.tile.is-dragging { opacity: .45; }
.tile.drop-target { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft), var(--shadow); }
.tile:hover, .tile.is-sel { border-color: var(--accent-line); box-shadow: var(--shadow); }
.tile .th { height: 116px; background: var(--paper-2); display: grid; place-items: center; position: relative; overflow: hidden; }
.tile .th .fi { width: 44px; height: 44px; border-radius: 10px; }
.tile .th .fi :deep(svg) { width: 24px; height: 24px; }
.tile .th .sync { position: absolute; right: 8px; bottom: 8px; background: rgba(255, 255, 255, .9); box-shadow: var(--shadow-sm); width: 22px; height: 22px; }
.tile .folderth { background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 8%, transparent), color-mix(in srgb, var(--accent) 14%, transparent)); }
.tile .agentth { background: rgba(26, 35, 50, .06); }
.tile .bd { padding: 10px 12px 11px; }
.tile .bd b { display: block; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12.5px; }
.tile .bd small { display: block; color: var(--dim); font-size: 11px; margin-top: 2px; }

/* Drop zone */
.drop { margin-top: 16px; border: 1.5px dashed var(--accent-line); border-radius: var(--r); padding: 22px; display: flex; align-items: center; gap: 14px; background: color-mix(in srgb, var(--accent) 4%, transparent); color: var(--muted); }
.drop .ico { width: 38px; height: 38px; border-radius: 10px; background: var(--accent-soft); color: var(--accent-2); display: grid; place-items: center; flex: none; }
.drop .ico :deep(svg) { width: 18px; height: 18px; }
.drop b { display: block; color: var(--text); font-weight: 600; font-size: 13px; }
.drop small { display: block; font-size: 12px; color: var(--muted); }
.drop .btn { margin-left: auto; }

/* Upload progress */
.upl { position: absolute; right: 24px; bottom: 24px; width: 320px; background: var(--card-solid); border: 1px solid var(--line); border-radius: var(--r); box-shadow: var(--shadow-lg); overflow: hidden; z-index: 20; }
.upl .hd { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--line); font-weight: 600; font-size: 12.5px; }
.upl .hd .btn.ico { margin-left: auto; width: 24px; height: 24px; padding: 3px; border: 0; box-shadow: none; background: transparent; color: var(--dim); }
.upl .hd .btn.ico :deep(svg) { width: 14px; height: 14px; }
.upl .it { display: flex; align-items: center; gap: 10px; padding: 8px 14px; font-size: 12px; }
.upl .it .t { flex: 1; min-width: 0; }
.upl .it .t b { display: block; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.upl .it .t small { display: block; color: var(--dim); font-size: 11px; }
.upl .it .prog { height: 3px; border-radius: 2px; background: var(--paper-2); margin-top: 5px; overflow: hidden; }
.upl .it .prog i { display: block; height: 100%; background: var(--accent); border-radius: 2px; }
.upl .it .fi { width: 26px; height: 26px; }
.upl .it .fi :deep(svg) { width: 14px; height: 14px; }

/* Loading, error and empty states */
.state-panel { display: flex; min-height: 320px; flex-direction: column; align-items: center; justify-content: center; padding: 40px; border: 1px solid var(--line); border-radius: var(--r); color: var(--muted); background: var(--card); box-shadow: var(--shadow); text-align: center; }
.state-panel strong { margin-top: 12px; color: var(--text); font-size: 15px; font-weight: 600; }
.state-panel p { max-width: 430px; margin: 6px 0 16px; }
.state-panel > div { display: flex; gap: 8px; }
.state-icon { display: grid; width: 38px; height: 38px; color: var(--accent-2); }
.state-icon :deep(svg) { width: 38px; height: 38px; }
.error-state .state-icon { color: var(--bad); }
.loader { display: inline-block; width: 22px; height: 22px; border: 2px solid var(--accent-soft); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
.drop-overlay { position: absolute; z-index: 30; inset: 14px; display: flex; flex-direction: column; align-items: center; justify-content: center; border: 1.5px dashed var(--accent-line); border-radius: var(--r); color: var(--accent-2); background: color-mix(in srgb, var(--paper) 90%, transparent); backdrop-filter: blur(12px); }
.drop-overlay > span { display: grid; width: 48px; height: 48px; }
.drop-overlay > span :deep(svg) { width: 48px; height: 48px; }
.drop-overlay strong { margin-top: 12px; color: var(--text); font-size: 15px; font-weight: 600; }
.drop-overlay p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }

/* Detail panel (opened with double-click or the row ⋯ button) */
.detail-panel { position: absolute; z-index: 8; top: 0; right: 0; bottom: 0; width: min(390px, 42vw); overflow: auto; border-left: 1px solid var(--line); background: var(--card-solid); box-shadow: var(--shadow-lg); }
.detail-panel > header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line); background: var(--card-solid); }
.detail-panel > header .file-name { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
.detail-panel > header .file-name > span:last-child { min-width: 0; }
.detail-panel > header strong, .detail-panel > header small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail-panel > header strong { font-weight: 600; }
.detail-panel > header small { color: var(--dim); font-size: 11px; }
.detail-panel > header > button { width: 28px; height: 28px; border: 0; border-radius: 8px; color: var(--dim); background: transparent; font-size: 20px; }
.preview-box { display: grid; min-height: 250px; max-height: 390px; margin: 16px; place-items: center; overflow: hidden; border: 1px solid var(--line); border-radius: var(--r); background: var(--paper-2); }
.preview-box img, .preview-box video, .preview-box iframe { width: 100%; height: 100%; max-height: 388px; object-fit: contain; border: 0; }
.preview-box audio { width: 88%; }
.preview-box pre { width: 100%; height: 100%; max-height: 388px; margin: 0; padding: 16px; overflow: auto; color: var(--muted); font: 11.5px/1.6 var(--mono); white-space: pre-wrap; }
.preview-placeholder { text-align: center; color: var(--dim); }
.large-glyph { display: grid; width: 44px; height: 44px; margin: auto; place-items: center; }
.large-glyph :deep(svg) { width: 32px; height: 32px; }
.preview-placeholder p { max-width: 260px; }
.detail-actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 16px 16px; }
.detail-tabs { display: flex; padding: 0 16px; border-bottom: 1px solid var(--line); }
.detail-tabs button { padding: 10px 8px; border: 0; border-bottom: 2px solid transparent; color: var(--muted); background: transparent; font-size: 12.5px; font-weight: 500; }
.detail-tabs button.active { border-color: var(--accent); color: var(--text); font-weight: 600; }
.detail-tabs span { padding: 1px 6px; border-radius: 999px; background: var(--paper-2); font-size: 11px; }
.detail-body { padding: 16px; }
.detail-body dl { display: grid; grid-template-columns: 84px 1fr; gap: 10px; margin: 0; font-size: 12.5px; }
.detail-body dt { color: var(--dim); }
.detail-body dd { min-width: 0; margin: 0; color: var(--text); overflow-wrap: anywhere; }
.status-inline { display: inline-flex; align-items: center; gap: 7px; }
.sync-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); flex: none; }
.sync-dot.syncing { background: var(--accent); }
.sync-dot.paused { background: var(--warn); }
.sync-dot.error, .sync-dot.conflict { background: var(--bad); }
.coming-card { margin-top: 18px; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--r); background: var(--accent-soft); }
.coming-card strong { font-size: 12.5px; }
.coming-card p { margin: 4px 0 8px; color: var(--muted); font-size: 12px; }
.coming-card span { color: var(--accent-2); font-size: 10.5px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
.versions-list { padding: 10px 16px 18px; }
.version-row { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--line); }
.version-number { display: grid; width: 28px; height: 28px; place-items: center; border-radius: 50%; color: var(--accent-2); background: var(--accent-soft); font: 11px var(--mono); }
.version-row strong, .version-row small { display: block; }
.version-row strong { font-size: 12.5px; font-weight: 500; }
.version-row small { margin-top: 2px; color: var(--dim); font-size: 11px; }
.current-pill { display: inline-flex; padding: 2px 8px; border-radius: 999px; color: var(--accent-2); background: var(--accent-soft); font-size: 11px; font-weight: 600; }
.version-note, .mini-state { color: var(--dim); font-size: 11px; }
.mini-state { display: flex; align-items: center; gap: 8px; padding: 20px; }
.mini-state .loader { width: 16px; height: 16px; }
.detail-enter-active, .detail-leave-active { transition: transform .22s ease, opacity .18s ease; }
.detail-enter-from, .detail-leave-to { transform: translateX(30px); opacity: 0; }
@keyframes spin { to { transform: rotate(360deg); } }

/* Mockup breakpoints, measured against the Files surface instead of the window */
@container (max-width: 1180px) {
  .nav { width: 64px; padding: 14px 10px; }
  .nav a { justify-content: center; padding: 9px 0; position: relative; }
  .nav a > span:not(.sv):not(.cnt), .brand b, .brand span, .root-picker, .tree-roots, .collection-drops, .nav .grp, .nav .foot small, .nav .foot div:not(.avatar), .nav .quota, .syncline { display: none; }
  .nav a .cnt { position: absolute; margin: 0; transform: translate(14px, -10px); }
  .brand { justify-content: center; padding-bottom: 12px; }
  .content { padding: 16px 18px 50px; }
  .top { padding: 10px 18px; }
  .top .search { max-width: 360px; }
  .col-size, .col-owner-name { display: none; }
  .files .own .nm { display: none; }
}
@container (max-width: 700px) {
  .crumbs > span, .crumbs .c { display: none; }
  .top { flex-wrap: wrap; gap: 8px; padding: 10px 14px; }
  .top .search { order: 5; flex-basis: 100%; max-width: none; width: 100%; }
  .top .search kbd { display: none; }
  .content { padding: 12px 12px 40px; }
  .toolbar { flex-wrap: wrap; gap: 4px 10px; }
  .filters { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 4px; scrollbar-width: none; }
  .filters .view { margin-left: 0; flex: none; }
  .files .tbl th:nth-child(1), .files .tbl td:nth-child(1), .files .tbl th:nth-child(3), .files .tbl td:nth-child(3), .files .tbl th:nth-child(5), .files .tbl td:nth-child(5) { display: none; }
  .files .actions .btn:not([title="More"]){display:none}
  .files .tbl th:nth-child(7){width:80px!important}
  .gridv { grid-template-columns: repeat(2, 1fr); gap: 10px; }
  .drop { flex-wrap: wrap; }
  .drop .btn { margin-left: 0; }
  .upl { display: none; }
  .detail-panel { width: calc(100% - 64px); }
}
.details-action{opacity:1;white-space:nowrap}.row:focus-visible,.tile:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}.folder-details{max-width:min(440px,calc(100vw - 32px));border:1px solid var(--line-2);border-radius:12px;background:var(--card-solid);color:var(--text);padding:24px}.folder-details::backdrop{background:rgba(26,35,50,.35)}.folder-details dl{display:grid;grid-template-columns:auto 1fr;gap:10px}.folder-details dd{margin:0;overflow-wrap:anywhere}.folder-details .btn{margin-right:8px}
.more-system-areas{border:0;background:transparent;color:var(--muted);text-align:left;padding:6px 12px;font-size:11px;cursor:pointer}
</style>
