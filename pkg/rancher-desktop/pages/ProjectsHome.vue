<!--
  ProjectsHome — the Projects project state (issue ledger).

  Reads AND writes the Postgres work tables (work_projects → work_epics →
  work_tasks → work_task_comments) through the useProjects composable /
  work-items:* IPC bridge. Full CRUD: create/edit/archive projects, epics and
  tasks, edit every value, and comment on issues.

  Layout: pick a project on the left, its epics and issues render on the right.
  Today = epics-as-sections list; Board = the four status columns; Projects =
  the all-projects overview. Clicking an issue opens the detail drawer.
-->
<template>
  <div class="projects-home">
    <div class="ph-body">
      <!-- project list -->
      <aside class="ph-side">
        <div class="ph-side-h">
          <div class="ph-eyebrow">
            Outcome ledger
          </div>
          <h1>Projects</h1>
        </div>
        <div class="ph-list">
          <template
            v-for="group in groups"
            :key="group.label"
          >
            <div
              v-if="group.items.length"
              class="ph-grp"
            >
              {{ group.label }}
            </div>
            <button
              v-for="p in group.items"
              :key="p.id"
              type="button"
              class="ph-p"
              :class="{ on: p.id === selectedId }"
              @click="select(p.id)"
            >
              <span class="ph-pn"><span
                class="ph-st"
                :class="dotClass(p)"
              />{{ shortName(p) }}</span>
              <span class="ph-pc">{{ p.status === 'done' ? 'Closed' : `${p.openCount} open · ${p.doneCount} done` }}</span>
            </button>
          </template>
        </div>
        <div class="ph-side-f">
          <button
            type="button"
            class="ph-btn block"
            @click="openNewProject"
          >
            ＋ New project
          </button>
        </div>
      </aside>

      <!-- main -->
      <section class="ph-main">
        <div class="ph-top">
          <div class="ph-tabs">
            <button
              v-for="view in PROJECT_VIEWS"
              :key="view.key"
              type="button"
              class="ph-tab ph-view-tab"
              :class="{ on: tab === view.key }"
              :aria-pressed="tab === view.key"
              :aria-label="`${view.label} view`"
              @click="setProjectView(view.key)"
            >
              <span aria-hidden="true">{{ view.icon }}</span>{{ view.label }}
            </button>
            <button
              type="button"
              class="ph-tab"
              :class="{ on: tab === 'activity' }"
              @click="tab = 'activity'"
            >
              Activity
            </button>
            <button
              type="button"
              class="ph-tab"
              :class="{ on: tab === 'projects' }"
              @click="tab = 'projects'"
            >
              Projects
            </button>
            <button type="button" class="ph-tab" :class="{ on: tab === 'lanes' }" @click="tab = 'lanes'">Lanes</button>
            <button type="button" class="ph-tab" :class="{ on: tab === 'knowledge' }" @click="tab = 'knowledge'">Knowledge</button>
          </div>
          <div class="ph-sp" />
          <label
            v-if="isDataView"
            class="ph-search"
          ><span class="sr-only">Search visible work</span><input
            v-model="viewSearch"
            placeholder="Search this project…"
          ></label>
          <div
            v-if="isDataView"
            class="ph-view-presets"
          >
            <label><span class="sr-only">Saved view</span><select
              v-model="activeViewId"
              aria-label="Saved view"
              @change="applySavedView"
            >
              <option value="">
                Current view
              </option>
              <option
                v-for="view in savedViews"
                :key="view.id"
                :value="view.id"
              >
                {{ view.project_id ? 'Project' : 'Global' }} · {{ view.name }}
              </option>
            </select></label>
            <label><span class="sr-only">New saved view name</span><input
              v-model="viewName"
              aria-label="New saved view name"
              placeholder="View name"
              @keydown.enter.prevent="saveNamedView"
            ></label>
            <label class="ph-check"><input
              v-model="saveViewGlobally"
              type="checkbox"
            > Global</label>
            <button
              type="button"
              class="ph-btn ghost sm"
              :disabled="!viewName.trim()"
              @click="saveNamedView"
            >
              Save view
            </button>
          </div>
          <button
            type="button"
            class="ph-btn ghost"
            :disabled="isLoading"
            @click="refresh"
          >
            {{ isLoading ? 'Loading…' : '↻ Refresh' }}
          </button>
        </div>

        <div class="ph-canvas">
          <!-- states -->
          <div
            v-if="error"
            class="ph-state ph-err"
          >
            <b>Couldn't load Projects.</b>
            <p>{{ error }}</p>
            <button
              type="button"
              class="ph-btn"
              @click="refresh"
            >
              Try again
            </button>
          </div>
          <div
            v-else-if="isLoading && !loaded"
            class="ph-state"
          >
            Loading the ledger…
          </div>
          <div
            v-else-if="!projects.length"
            class="ph-state"
          >
            No projects yet. <button
              type="button"
              class="ph-btn"
              @click="openNewProject"
            >
              Create the first one
            </button>
          </div>

          <template v-else>
            <div
              v-if="laneCapability && !laneCapability.ready"
              class="ph-state ph-err"
            >
              <b>Lane automation is in compatibility mode.</b>
              <p>{{ laneCapability.degradedReason }}</p>
            </div>
            <div v-if="automationStatus" class="ph-automation-health" :class="{ held: !automationStatus.decision.allowed }">
              <div>
                <b>Conveyor capacity</b>
                <span v-if="automationStatus.decision.reason"> · {{ automationStatus.decision.reason }}</span>
                <span v-else> · upstream claims have capacity</span>
              </div>
              <div class="ph-automation-stages">
                <span v-for="role in automationRoles" :key="role" class="ph-pill">
                  {{ role }} {{ automationStatus.counts[role] || 0 }}/{{ automationStatus.limits[role] || '∞' }}
                </span>
              </div>
            </div>
            <section v-if="conveyorHealth" class="ph-health" aria-label="Projects conveyor health">
              <header class="ph-health-head">
                <div>
                  <b>Conveyor health</b>
                  <span> · {{ conveyorWindow }}h · {{ healthScopeProject ? 'current project' : 'portfolio' }}</span>
                </div>
                <div class="ph-health-controls">
                  <label><input v-model="healthScopeProject" type="checkbox"> Project only</label>
                  <select v-model.number="conveyorWindow" aria-label="Metrics window">
                    <option :value="24">24 hours</option>
                    <option :value="168">7 days</option>
                    <option :value="720">30 days</option>
                  </select>
                  <button type="button" class="ph-btn ghost sm" @click="loadConveyorHealth">Refresh</button>
                </div>
              </header>
              <div class="ph-health-grid">
                <button
                  v-for="stage in conveyorHealth.stages"
                  :key="stage.stage"
                  type="button"
                  class="ph-health-stat stage"
                  :class="{ on: healthStage === stage.stage }"
                  @click="loadHealthStage(stage.stage)"
                >
                  <span>{{ stage.stage }}</span><b>{{ stage.count }}</b><small>oldest {{ duration(stage.oldestAgeSeconds) }}</small>
                </button>
                <div class="ph-health-stat"><span>Throughput</span><b>{{ conveyorHealth.throughput.reachedDone }}</b><small>done · {{ conveyorHealth.throughput.reviewsCompleted }} reviews</small></div>
                <div class="ph-health-stat"><span>Verifier</span><b>{{ percent(conveyorHealth.verifier.utilization) }}</b><small>{{ conveyorHealth.verifier.activeVerificationLeases }}/{{ conveyorHealth.verifier.capacity ?? '∞' }} active</small></div>
                <div class="ph-health-stat"><span>Rework</span><b>{{ percent(conveyorHealth.rework.reworkRate) }}</b><small>{{ conveyorHealth.rework.avgRepairLoops.toFixed(1) }} loops avg</small></div>
                <div class="ph-health-stat"><span>Wait adoption</span><b>{{ percent(conveyorHealth.waits.adoptionRate) }}</b><small>{{ conveyorHealth.waits.blockedWithActiveWait }}/{{ conveyorHealth.waits.blockedTotal }} external gates</small></div>
                <div class="ph-health-stat"><span>Custody</span><b>{{ custodyPercent }}</b><small>latest completed artifacts</small></div>
                <div class="ph-health-stat"><span>Stale leases</span><b>{{ conveyorHealth.leases.staleLeases }}</b><small>{{ conveyorHealth.leases.activeLeases }} active total</small></div>
                <div class="ph-health-stat"><span>Dependency held</span><b>{{ conveyorHealth.deps.dependencyHeld }}</b><small>claim-gated tasks</small></div>
                <div class="ph-health-stat"><span>Shipments</span><b>{{ conveyorHealth.shipments.independentShipments }}</b><small>{{ conveyorHealth.shipments.integrationTrainClosures }} train · {{ conveyorHealth.shipments.missingEvidence }} missing</small></div>
              </div>
              <div v-if="healthItems.length" class="ph-health-drill">
                <b>Oldest {{ healthStage }} work</b>
                <button v-for="item in healthItems" :key="item.id" type="button" @click="openHealthTask(item.id)">
                  <span>{{ item.title }}</span><small>{{ duration(item.ageSeconds) }}</small>
                </button>
              </div>
            </section>
            <!-- TODAY -->
            <div
              v-show="tab === 'list'"
              v-if="sel"
              role="tree"
              aria-label="Project work list"
            >
              <div class="ph-lead">
                <div class="ph-lead-row">
                  <h2>{{ shortName(sel) }}</h2>
                  <div class="ph-actions">
                    <button
                      type="button"
                      class="ph-btn ghost sm"
                      @click="openEditProject(sel)"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      class="ph-btn ghost sm"
                      @click="openNewEpic(sel.id)"
                    >
                      ＋ Epic
                    </button>
                    <button
                      type="button"
                      class="ph-btn ghost sm danger"
                      @click="confirmArchiveProject(sel)"
                    >
                      Archive
                    </button>
                  </div>
                </div>
                <p v-if="sel.description">
                  {{ sel.description }}
                </p>
                <div class="ph-lead-meta">
                  <span
                    class="ph-pill"
                    :class="{ hb: isHeartbeat(sel) }"
                  >{{ sel.status }}</span>
                  <span class="ph-pill">{{ sel.priority }}</span>
                  <span
                    v-if="sel.owner"
                    class="ph-pill"
                  >owner: {{ sel.owner }}</span>
                  <span
                    v-if="sel.github_repo"
                    class="ph-pill"
                  >{{ sel.github_repo }}</span>
                  <span v-if="sel.knowledge_count" class="ph-pill">{{ sel.knowledge_count }} knowledge</span>
                </div>
              </div>

              <KnowledgeLinksPanel
                item-kind="project"
                :item-id="sel.id"
                @open-node="openKnowledgeNode"
              />

              <div
                v-for="epic in sel.epics"
                :key="epic.id"
                class="ph-sec"
                role="treeitem"
                :aria-expanded="!collapsedEpics.has(epic.id)"
                tabindex="0"
                :class="{ 'drop-epic': dnd.kind === 'epic' && dragOverEpicId === epic.id }"
                @dragover.prevent="dragOverEpicId = epic.id"
                @dragleave="dragOverEpicId = ''"
                @drop="onSectionDrop(epic)"
              >
                <div class="ph-sec-h">
                  <span
                    class="ph-drag"
                    draggable="true"
                    title="Drag to reorder epic"
                    @dragstart="onDragStartEpic(epic, $event)"
                    @dragend="onDragEnd"
                  >⠿</span>
                  <button
                    type="button"
                    class="ph-collapse"
                    :aria-label="`${collapsedEpics.has(epic.id) ? 'Expand' : 'Collapse'} ${epic.title}`"
                    @click="toggleEpic(epic.id)"
                  >
                    {{ collapsedEpics.has(epic.id) ? '▸' : '▾' }}
                  </button>
                  <h3>{{ epic.title }}</h3>
                  <span class="ph-cnt">{{ epicSummary(epic) }}</span>
                  <span v-if="epic.knowledge_count" class="ph-cnt">{{ epic.knowledge_count }} knowledge</span>
                  <div class="ph-sp" />
                  <div class="ph-actions">
                    <button
                      type="button"
                      class="ph-btn ghost xs"
                      @click="openNewTask(epic.id)"
                    >
                      ＋ Issue
                    </button>
                    <button
                      type="button"
                      class="ph-btn ghost xs"
                      @click="openEditEpic(epic)"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      class="ph-btn ghost xs danger"
                      @click="confirmArchiveEpic(epic)"
                    >
                      Archive
                    </button>
                  </div>
                </div>
                <KnowledgeLinksPanel
                  item-kind="epic"
                  :item-id="epic.id"
                  @open-node="openKnowledgeNode"
                />
                <div
                  v-if="!collapsedEpics.has(epic.id) && !filteredEpicTasks(epic).length"
                  class="ph-muted ph-dropzone"
                >
                  No matching work. Drop an issue here, or ＋ Issue to add one.
                </div>
                <div
                  v-for="t in (collapsedEpics.has(epic.id) ? [] : filteredEpicTasks(epic))"
                  :key="t.id"
                  class="ph-row"
                  :class="{ sel: openTask?.id === t.id, subtask: Boolean(t.parent_id), drop: dnd.kind === 'task' && dragOverTaskId === t.id }"
                  draggable="true"
                  role="treeitem"
                  tabindex="0"
                  :aria-label="`${t.title}, ${statusLabel(t.status)}`"
                  @click="openTaskDrawer(t)"
                  @keydown.enter="openTaskDrawer(t)"
                  @keydown.space.prevent="toggleSelection(t.id)"
                  @dragstart.stop="onDragStartTask(t, epic.id, $event)"
                  @dragend="onDragEnd"
                  @dragover.prevent.stop="dragOverTaskId = t.id"
                  @dragleave.stop="dragOverTaskId = ''"
                  @drop.stop="onRowDrop(t, epic)"
                >
                  <span class="ph-grip">⠿</span>
                  <span
                    v-if="t.parent_id"
                    class="ph-subtask-mark"
                    aria-label="Subtask"
                  >↳</span>
                  <span
                    class="ph-mark"
                    :class="markClass(t.status)"
                  />
                  <div class="ph-rbody">
                    <div
                      class="ph-t"
                      v-html="cleanTitle(t.title)"
                    />
                    <div
                      v-if="showPriority(t.priority)"
                      class="ph-m"
                    >
                      <span>{{ t.priority }}</span>
                    </div>
                    <div v-if="t.knowledge_count" class="ph-m"><span>{{ t.knowledge_count }} knowledge</span></div>
                  </div>
                  <span
                    class="ph-tag"
                    :class="{ wait: isBlockedStatus(t.status) }"
                  >{{ statusLabel(t.status) }}</span>
                </div>
              </div>
              <div
                v-if="!sel.epics.length"
                class="ph-muted"
              >
                No epics yet. <button
                  type="button"
                  class="ph-btn xs"
                  @click="openNewEpic(sel.id)"
                >
                  ＋ Add an epic
                </button>
              </div>
            </div>

            <!-- BOARD -->
            <div
              v-show="tab === 'board'"
              v-if="sel"
            >
              <div class="ph-cols">
                <div
                  v-for="col in boardColumns"
                  :key="col.key"
                  class="ph-col"
                  :class="{ 'drop-col': dnd.kind === 'task' && dragOverCol === col.key }"
                  @dragover.prevent="dragOverCol = col.key"
                  @dragleave="dragOverCol = ''"
                  @drop="onColumnDrop(col.key)"
                >
                  <div class="ph-colh">
                    <span
                      class="ph-cd"
                      :style="{ background: col.color }"
                    />{{ col.label }} <span class="ph-n">{{ col.items.length }}</span>
                    <span class="ph-sp" />
                    <button type="button" class="ph-lane-action" :aria-label="`Customize ${col.label}`" @click="openLaneEditor(col.key)">Customize</button>
                    <button type="button" class="ph-lane-action" :aria-label="`Assign workflow to ${col.label}`" @click="openLaneAssignment(col.key)">Automate</button>
                  </div>
                  <div
                    v-if="!col.items.length"
                    class="ph-card ghost"
                  >
                    <div class="ph-ct">
                      Drop here
                    </div>
                  </div>
                  <div
                    v-for="t in col.items"
                    :key="t.id"
                    class="ph-card"
                    draggable="true"
                    role="button"
                    tabindex="0"
                    @click="openTaskDrawer(t)"
                    @keydown.enter="openTaskDrawer(t)"
                    @keydown.space.prevent="openTaskDrawer(t)"
                    @dragstart="onDragStartTask(t, t.epic_id, $event)"
                    @dragend="onDragEnd"
                  >
                    <div
                      class="ph-ct"
                      v-html="cleanTitle(t.title)"
                    />
                    <div
                      v-if="showPriority(t.priority)"
                      class="ph-cm"
                    >
                      {{ t.priority }}
                    </div>
                    <select
                      :value="t.status"
                      :aria-label="`Move ${t.title} to lane`"
                      @click.stop
                      @change.stop="inlineTaskField(t, 'status', inputValue($event))"
                    >
                      <option
                        v-for="status in STATUSES"
                        :key="status"
                        :value="status"
                      >
                        {{ statusLabel(status) }}
                      </option>
                    </select>
                    <div v-if="t.knowledge_count" class="ph-cm">{{ t.knowledge_count }} knowledge</div>
                  </div>
                </div>
              </div>
            </div>

            <!-- TABLE: bounded rows, canonical inline edits -->
            <div
              v-show="tab === 'table'"
              v-if="sel"
              class="ph-data-view"
            >
              <div class="ph-view-meta">
                <span
                  class="sr-only"
                  role="status"
                  aria-live="polite"
                >Showing {{ Math.min(visibleTasks.length, TABLE_RENDER_LIMIT) }} of {{ visibleTasks.length }} matching tasks</span>
                <b>{{ visibleTasks.length }}</b> matching tasks <span v-if="allTasks.length > TABLE_RENDER_LIMIT">· rendering first {{ TABLE_RENDER_LIMIT }} of {{ allTasks.length }}</span>
              </div>
              <div
                class="ph-table-wrap"
                role="region"
                aria-label="Projects table"
                tabindex="0"
              >
                <table class="ph-table">
                  <thead>
                    <tr>
                      <th scope="col">
                        Select
                      </th><th scope="col">
                        Title
                      </th><th scope="col">
                        Epic
                      </th><th scope="col">
                        Status
                      </th><th scope="col">
                        Priority
                      </th><th scope="col">
                        Assignee
                      </th><th scope="col">
                        Start
                      </th><th scope="col">
                        Due
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="row in visibleTasks.slice(0, TABLE_RENDER_LIMIT)"
                      :key="row.task.id"
                      :class="{ selected: selectedTasks.has(row.task.id) }"
                    >
                      <td>
                        <input
                          type="checkbox"
                          :checked="selectedTasks.has(row.task.id)"
                          :aria-label="`Select ${row.task.title}`"
                          @change="toggleSelection(row.task.id)"
                        >
                      </td>
                      <td>
                        <button
                          class="ph-link"
                          type="button"
                          @click="openTaskDrawer(row.task)"
                        >
                          {{ row.task.title }}
                        </button>
                      </td>
                      <td>{{ row.epic.title }}</td>
                      <td>
                        <select
                          :value="row.task.status"
                          :aria-label="`Status for ${row.task.title}`"
                          @change="inlineTaskField(row.task, 'status', inputValue($event))"
                        >
                          <option
                            v-for="s in STATUSES"
                            :key="s"
                            :value="s"
                          >
                            {{ statusLabel(s) }}
                          </option>
                        </select>
                      </td>
                      <td>
                        <select
                          :value="row.task.priority"
                          :aria-label="`Priority for ${row.task.title}`"
                          @change="inlineTaskField(row.task, 'priority', inputValue($event))"
                        >
                          <option
                            v-for="p in PRIORITIES"
                            :key="p"
                            :value="p"
                          >
                            {{ p }}
                          </option>
                        </select>
                      </td>
                      <td>
                        <input
                          :value="row.task.assignee || ''"
                          :aria-label="`Assignee for ${row.task.title}`"
                          @change="inlineTaskField(row.task, 'assignee', inputValue($event) || null)"
                        >
                      </td>
                      <td>
                        <input
                          type="date"
                          :value="ymd(row.task.start_at)"
                          :aria-label="`Start date for ${row.task.title}`"
                          @change="inlineTaskField(row.task, 'start_at', isoFromYmd(inputValue($event)))"
                        >
                      </td>
                      <td>
                        <input
                          type="date"
                          :value="ymd(row.task.due_at)"
                          :aria-label="`Due date for ${row.task.title}`"
                          @change="inlineTaskField(row.task, 'due_at', isoFromYmd(inputValue($event)))"
                        >
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <!-- GANTT: real spans only; no fabricated dates -->
            <div
              v-show="tab === 'gantt'"
              v-if="sel"
              class="ph-data-view"
            >
              <div class="ph-view-tools">
                <button
                  v-for="z in ['day', 'week', 'month']"
                  :key="z"
                  type="button"
                  class="ph-btn xs"
                  :class="{ primary: ganttZoom === z }"
                  @click="setZoom(z as GanttZoom)"
                >
                  {{ z }}
                </button><button
                  type="button"
                  class="ph-btn xs"
                  @click="dateAnchor = todayYmd"
                >
                  Today
                </button>
              </div>
              <div
                class="ph-gantt"
                :class="`zoom-${ganttZoom}`"
                role="region"
                aria-label="Project schedule"
              >
                <div
                  class="ph-today-line"
                  :style="{ left: ganttTodayOffset + '%' }"
                >
                  <span>Today</span>
                </div>
                <div
                  v-for="row in scheduledTasks"
                  :key="row.task.id"
                  class="ph-gantt-row"
                >
                  <div class="ph-gantt-label-wrap">
                    <button
                      type="button"
                      class="ph-gantt-label"
                      @click="openTaskDrawer(row.task)"
                    >
                      {{ row.task.title }}
                    </button>
                    <div class="ph-gantt-dates">
                      <input
                        type="date"
                        :value="ymd(row.task.start_at)"
                        :aria-label="`Start date for ${row.task.title}`"
                        @change="inlineTaskField(row.task, 'start_at', isoFromYmd(inputValue($event)))"
                      >
                      <input
                        type="date"
                        :value="ymd(row.task.due_at)"
                        :aria-label="`Due date for ${row.task.title}`"
                        @change="inlineTaskField(row.task, 'due_at', isoFromYmd(inputValue($event)))"
                      >
                    </div>
                  </div>
                  <div class="ph-gantt-track">
                    <button
                      type="button"
                      class="ph-gantt-bar"
                      :style="ganttStyle(row.task)"
                      :aria-label="`${row.task.title}, ${ymd(row.task.start_at || row.task.due_at)} to ${ymd(row.task.due_at || row.task.start_at)}`"
                      @click="openTaskDrawer(row.task)"
                    >
                      <span
                        v-if="row.task.milestone_at"
                        class="ph-milestone"
                        aria-label="Milestone"
                      >◆</span>
                    </button>
                  </div>
                </div>
              </div>
              <div class="ph-unscheduled">
                <h3>Unscheduled work <span>{{ unscheduledTasks.length }}</span></h3><button
                  v-for="row in unscheduledTasks"
                  :key="row.task.id"
                  type="button"
                  @click="openTaskDrawer(row.task)"
                >
                  {{ row.task.title }}
                </button>
              </div>
            </div>

            <!-- CALENDAR: dragging commits due_at through WorkItemsModel -->
            <div
              v-show="tab === 'calendar'"
              v-if="sel"
              class="ph-data-view"
            >
              <div class="ph-view-tools">
                <button
                  type="button"
                  class="ph-btn xs"
                  aria-label="Previous month"
                  @click="shiftMonth(-1)"
                >
                  ←
                </button><b>{{ calendarTitle }}</b><button
                  type="button"
                  class="ph-btn xs"
                  aria-label="Next month"
                  @click="shiftMonth(1)"
                >
                  →
                </button><button
                  type="button"
                  class="ph-btn xs"
                  @click="calendarAnchor = todayYmd"
                >
                  Today
                </button>
              </div>
              <div
                class="ph-calendar"
                role="grid"
                :aria-label="calendarTitle"
              >
                <div
                  v-for="name in WEEKDAYS"
                  :key="name"
                  role="columnheader"
                  class="ph-calendar-head"
                >
                  {{ name }}
                </div><div
                  v-for="day in calendarDays"
                  :key="day.ymd"
                  role="gridcell"
                  class="ph-day"
                  :class="{ muted: !day.inMonth, today: day.ymd === todayYmd }"
                  @dragover.prevent
                  @drop="dropOnDate(day.ymd)"
                >
                  <span>{{ day.day }}</span><button
                    v-for="row in tasksForDate(day.ymd)"
                    :key="row.task.id"
                    type="button"
                    draggable="true"
                    @dragstart="calendarDragId = row.task.id"
                    @click="openTaskDrawer(row.task)"
                  >
                    {{ row.task.milestone_at ? '◆ ' : '' }}{{ row.task.title }}
                  </button>
                </div>
              </div>
              <div class="ph-unscheduled">
                <h3>Unscheduled work <span>{{ unscheduledTasks.length }}</span></h3><button
                  v-for="row in unscheduledTasks"
                  :key="row.task.id"
                  type="button"
                  draggable="true"
                  @dragstart="calendarDragId = row.task.id"
                >
                  {{ row.task.title }}
                </button>
              </div>
            </div>

            <!-- ACTIVITY -->
            <div
              v-show="tab === 'activity'"
              v-if="sel"
            >
              <div class="ph-lead ph-activity-lead">
                <div class="ph-lead-row">
                  <h2>Recent activity</h2>
                  <div class="ph-actions">
                    <button
                      type="button"
                      class="ph-btn ghost sm"
                      :disabled="activityLoading"
                      @click="refreshActivity"
                    >
                      {{ activityLoading ? 'Loading…' : '↻ Refresh' }}
                    </button>
                  </div>
                </div>
                <p>{{ shortName(sel) }} · newest first — comments, new tasks &amp; epics, status and metadata changes.</p>
              </div>
              <div
                v-if="activityLoading && !activity.length"
                class="ph-state"
              >
                Loading recent activity…
              </div>
              <div
                v-else-if="!activity.length"
                class="ph-state"
              >
                No activity has been recorded for this project yet.
              </div>
              <div
                v-else
                class="ph-timeline"
              >
                <button
                  v-for="item in activity"
                  :key="item.id"
                  type="button"
                  class="ph-activity"
                  :class="{ 'is-event': item.kind !== 'comment' }"
                  @click="openActivityTask(item)"
                >
                  <span
                    class="ph-activity-dot"
                    :class="[activityActorClass(item), { event: item.kind !== 'comment' }]"
                  />
                  <span class="ph-activity-body">
                    <span class="ph-activity-meta">
                      <span
                        class="ph-activity-kind"
                        :class="'k-' + item.kind"
                      >{{ activityKindLabel(item.kind) }}</span>
                      <span
                        class="ph-activity-actor"
                        :class="activityActorClass(item)"
                      >{{ activityActorLabel(item) }}</span>
                      <span>{{ shortDate(item.activity_at) }}</span>
                      <span v-if="item.epic_title">{{ item.epic_title }}</span>
                    </span>
                    <span
                      class="ph-activity-task"
                      v-html="cleanTitle(activityTitle(item))"
                    />
                    <span class="ph-activity-text">{{ activityText(item) }}</span>
                  </span>
                  <span
                    class="ph-tag"
                    :class="{ wait: isBlockedStatus(item.task_status) }"
                  >{{ statusLabel(item.task_status) }}</span>
                </button>
              </div>
            </div>

            <!-- PROJECTS -->
            <div v-show="tab === 'projects'">
              <div class="ph-grid">
                <div
                  v-for="p in projects"
                  :key="p.id"
                  class="ph-pcard"
                  @click="select(p.id); tab = 'list'"
                >
                  <div
                    class="ph-lane"
                    :class="{ hb: isHeartbeat(p) }"
                  >
                    {{ laneLabel(p) }}
                  </div>
                  <h3>{{ shortName(p) }}</h3>
                  <p v-if="p.description">
                    {{ p.description }}
                  </p>
                  <div
                    class="ph-prog"
                    :class="progClass(p)"
                  >
                    <i :style="{ width: pct(p) + '%' }" />
                  </div>
                  <div class="ph-nums">
                    <span><b>{{ p.openCount }}</b> open</span>
                    <span><b>{{ p.doneCount }}</b> done</span>
                    <span><b>{{ p.epics.length }}</b> epics</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- LANE SETTINGS -->
            <LaneSettings v-if="sel" v-show="tab === 'lanes'" ref="laneSettings" :project="sel" @refresh="refresh" />

            <!-- KNOWLEDGE BASE -->
            <div v-show="tab === 'knowledge'">
              <KnowledgeBrowserPanel
                :projects="projects"
                :selected-node-id="selectedKnowledgeNodeId"
                @open-work="openLinkedWork"
              />
            </div>
          </template>
        </div>
      </section>
    </div>

    <!-- ══════════ TASK DETAIL DRAWER ══════════ -->
    <div
      v-if="openTask"
      class="ph-scrim"
      @click="closeTask"
    />
    <aside
      v-if="openTask"
      class="ph-drawer"
    >
      <div class="ph-dh">
        <div class="ph-dh-id">
          {{ taskMode === 'create' ? 'NEW ISSUE' : `ISSUE · ${openTask.id}` }}
        </div>
        <button
          type="button"
          class="ph-x"
          @click="closeTask"
        >
          ✕
        </button>
      </div>
      <div class="ph-db">
        <label class="ph-fl">Title</label>
        <textarea
          v-model="taskDraft.title"
          class="ph-in ph-ta"
          rows="2"
          placeholder="What needs doing?"
        />

        <div class="ph-frow">
          <div>
            <label class="ph-fl">Status</label>
            <select
              v-model="taskDraft.status"
              class="ph-in"
            >
              <option
                v-for="s in STATUSES"
                :key="s"
                :value="s"
              >
                {{ statusLabel(s) }}
              </option>
            </select>
          </div>
          <div>
            <label class="ph-fl">Priority</label>
            <select
              v-model="taskDraft.priority"
              class="ph-in"
            >
              <option
                v-for="p in PRIORITIES"
                :key="p"
                :value="p"
              >
                {{ p }}
              </option>
            </select>
          </div>
        </div>

        <div class="ph-frow">
          <div>
            <label class="ph-fl">Epic</label>
            <select
              v-model="taskDraft.epic_id"
              class="ph-in"
            >
              <option
                v-for="e in (sel?.epics ?? [])"
                :key="e.id"
                :value="e.id"
              >
                {{ e.title }}
              </option>
            </select>
          </div>
          <div>
            <label class="ph-fl">Assignee</label>
            <select
              v-model="taskDraft.assignee"
              class="ph-in"
            >
              <option value="">
                unassigned
              </option>
              <option
                v-for="a in ASSIGNEES"
                :key="a.value"
                :value="a.value"
              >
                {{ a.label }}
              </option>
              <option
                v-if="taskDraft.assignee && !isKnownAssignee(taskDraft.assignee)"
                :value="taskDraft.assignee"
              >
                {{ taskDraft.assignee }}
              </option>
            </select>
          </div>
        </div>

        <div class="ph-frow">
          <div>
            <label class="ph-fl">Start</label>
            <input
              v-model="taskStartYmd"
              type="date"
              class="ph-in"
            >
          </div>
          <div>
            <label class="ph-fl">Due</label>
            <input
              v-model="taskDueYmd"
              type="date"
              class="ph-in"
            >
          </div>
        </div>
        <div class="ph-frow">
          <div>
            <label class="ph-fl">Milestone</label>
            <input
              v-model="taskMilestoneYmd"
              type="date"
              class="ph-in"
            >
          </div>
          <div>
            <label class="ph-fl">GitHub issue</label>
            <input
              v-model="taskDraft.github_issue"
              class="ph-in"
              placeholder="owner/repo#123"
            >
          </div>
        </div>

        <template v-if="taskMode === 'edit'">
          <label class="ph-fl">Dependencies</label>
          <div
            v-if="currentDependencies.length"
            class="ph-dependencies"
          >
            <div
              v-for="dependency in currentDependencies"
              :key="dependency.depends_on_task_id"
              class="ph-dependency"
            >
              <span>Blocked by {{ taskTitle(dependency.depends_on_task_id) }}</span>
              <button
                type="button"
                class="ph-btn ghost xs"
                :aria-label="`Remove dependency ${taskTitle(dependency.depends_on_task_id)}`"
                @click="removeDependency(dependency.depends_on_task_id)"
              >
                Remove
              </button>
            </div>
          </div>
          <div class="ph-frow">
            <select
              v-model="dependencyCandidate"
              class="ph-in"
              aria-label="Task dependency"
            >
              <option value="">
                Choose prerequisite…
              </option>
              <option
                v-for="task in dependencyCandidates"
                :key="task.id"
                :value="task.id"
              >
                {{ task.title }}
              </option>
            </select>
            <button
              type="button"
              class="ph-btn ghost"
              :disabled="!dependencyCandidate"
              @click="addDependency"
            >
              Add dependency
            </button>
          </div>
        </template>

        <label class="ph-fl">Description</label>
        <textarea
          v-model="taskDraft.description"
          class="ph-in ph-ta"
          rows="4"
          placeholder="Details, context, next action…"
        />

        <div class="ph-dactions">
          <button
            type="button"
            class="ph-btn primary"
            :disabled="saving || !taskDraft.title"
            @click="saveTask"
          >
            {{ saving ? 'Saving…' : (taskMode === 'create' ? 'Create issue' : 'Save changes') }}
          </button>
          <button
            v-if="taskMode === 'edit'"
            type="button"
            class="ph-btn ghost danger"
            :disabled="saving"
            @click="confirmArchiveTask"
          >
            Archive
          </button>
        </div>

        <KnowledgeLinksPanel
          v-if="taskMode === 'edit' && openTask?.id"
          item-kind="task"
          :item-id="openTask.id"
          @open-node="openKnowledgeNode"
        />

        <!-- comments -->
        <template v-if="taskMode === 'edit'">
          <div class="ph-cmt-h">
            Comments <span>{{ taskComments.length }}</span>
          </div>
          <div
            v-for="c in taskComments"
            :key="c.id"
            class="ph-cmt"
          >
            <div class="ph-cmt-who">
              {{ c.author || 'agent' }} · {{ shortDate(c.created_at) }}
            </div>
            <div class="ph-cmt-b">
              {{ c.body }}
            </div>
            <button
              v-if="isArtifactReceipt(c.body)"
              type="button"
              class="ph-btn ghost xs"
              @click="toggleReceiptEvidence(c.id)"
            >
              {{ receiptEvidence[c.id] ? 'Hide full evidence' : 'Open full evidence' }}
            </button>
            <pre v-if="receiptEvidence[c.id]" class="ph-receipt-evidence">{{ receiptEvidence[c.id] }}</pre>
          </div>
          <div
            v-if="!taskComments.length"
            class="ph-muted"
          >
            No comments yet.
          </div>
          <div class="ph-cmt-add">
            <textarea
              v-model="newComment"
              class="ph-in ph-ta"
              rows="2"
              placeholder="Add a comment…"
            />
            <button
              type="button"
              class="ph-btn"
              :disabled="saving || !newComment.trim()"
              @click="postComment"
            >
              Comment
            </button>
          </div>
        </template>
      </div>
    </aside>

    <!-- ══════════ PROJECT MODAL ══════════ -->
    <div
      v-if="projectModal.open"
      class="ph-scrim center"
      @click="projectModal.open = false"
    >
      <div
        class="ph-modal"
        @click.stop
      >
        <h2>{{ projectModal.mode === 'create' ? 'New project' : 'Edit project' }}</h2>
        <label class="ph-fl">Title</label>
        <input
          v-model="projectDraft.title"
          class="ph-in"
          placeholder="Project name"
        >
        <label class="ph-fl">Description</label>
        <textarea
          v-model="projectDraft.description"
          class="ph-in ph-ta"
          rows="3"
        />
        <div class="ph-frow">
          <div>
            <label class="ph-fl">Status</label>
            <select
              v-model="projectDraft.status"
              class="ph-in"
            >
              <option
                v-for="s in STATUSES"
                :key="s"
                :value="s"
              >
                {{ statusLabel(s) }}
              </option>
            </select>
          </div>
          <div>
            <label class="ph-fl">Priority</label>
            <select
              v-model="projectDraft.priority"
              class="ph-in"
            >
              <option
                v-for="p in PRIORITIES"
                :key="p"
                :value="p"
              >
                {{ p }}
              </option>
            </select>
          </div>
        </div>
        <div class="ph-frow">
          <div>
            <label class="ph-fl">Owner</label>
            <input
              v-model="projectDraft.owner"
              class="ph-in"
              placeholder="who owns it"
            >
          </div>
          <div>
            <label class="ph-fl">GitHub repo</label>
            <input
              v-model="projectDraft.github_repo"
              class="ph-in"
              placeholder="owner/repo"
            >
          </div>
        </div>
        <label class="ph-fl">Outcome metric</label>
        <input
          v-model="projectDraft.outcome_metric"
          class="ph-in"
          placeholder="how you know it's done"
        >
        <div class="ph-dactions">
          <button
            type="button"
            class="ph-btn primary"
            :disabled="saving || !projectDraft.title"
            @click="saveProject"
          >
            {{ saving ? 'Saving…' : (projectModal.mode === 'create' ? 'Create' : 'Save') }}
          </button>
          <button
            type="button"
            class="ph-btn ghost"
            @click="projectModal.open = false"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>

    <!-- ══════════ EPIC MODAL ══════════ -->
    <div
      v-if="epicModal.open"
      class="ph-scrim center"
      @click="epicModal.open = false"
    >
      <div
        class="ph-modal"
        @click.stop
      >
        <h2>{{ epicModal.mode === 'create' ? 'New epic' : 'Edit epic' }}</h2>
        <label class="ph-fl">Title</label>
        <input
          v-model="epicDraft.title"
          class="ph-in"
          placeholder="Epic name"
        >
        <label class="ph-fl">Description</label>
        <textarea
          v-model="epicDraft.description"
          class="ph-in ph-ta"
          rows="3"
        />
        <div class="ph-frow">
          <div>
            <label class="ph-fl">Status</label>
            <select
              v-model="epicDraft.status"
              class="ph-in"
            >
              <option
                v-for="s in STATUSES"
                :key="s"
                :value="s"
              >
                {{ statusLabel(s) }}
              </option>
            </select>
          </div>
          <div>
            <label class="ph-fl">Priority</label>
            <select
              v-model="epicDraft.priority"
              class="ph-in"
            >
              <option
                v-for="p in PRIORITIES"
                :key="p"
                :value="p"
              >
                {{ p }}
              </option>
            </select>
          </div>
        </div>
        <div class="ph-dactions">
          <button
            type="button"
            class="ph-btn primary"
            :disabled="saving || !epicDraft.title"
            @click="saveEpic"
          >
            {{ saving ? 'Saving…' : (epicModal.mode === 'create' ? 'Create' : 'Save') }}
          </button>
          <button
            type="button"
            class="ph-btn ghost"
            @click="epicModal.open = false"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';

import LaneSettings from '@pkg/components/projects/LaneSettings.vue';
import type { LinkedWorkItemRecord } from '@pkg/agent/database/models/WorkItemKnowledgeModel';
import KnowledgeBrowserPanel from '@pkg/components/KnowledgeBrowserPanel.vue';
import KnowledgeLinksPanel from '@pkg/components/KnowledgeLinksPanel.vue';
import type { BackpressureDecision, RoleCounts, WipLimits } from '@pkg/agent/services/ProjectAutomationWipLimits';
import type { SemanticStage, WorkConveyorMetricsModel } from '@pkg/agent/database/models/WorkConveyorMetricsModel';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import {
  useProjects,
  type ProjectView, type EpicWithTasks, type TaskView, type WorkTaskRecord, type WorkCommentRecord, type WorkActivityRecord,
  type WorkTaskDependencyRecord,
  type UpsertProjectInput, type UpsertEpicInput, type UpsertTaskInput, type ReorderUpdate,
  type ProjectViewType, type WorkProjectViewRecord,
} from '@pkg/composables/useProjects';

const {
  projects, selected: sel, selectedId, isLoading, error, loaded, load, select,
  loadComments, loadActivity, createProject, updateProject, archiveProject,
  createEpic, updateEpic, archiveEpic,
  createTask, updateTask, archiveTask, addComment, reorder,
  lanesByProject, laneCapability,
  listViews, resolveView, saveView,
  listTaskDependencies, setTaskDependency, removeTaskDependency,
} = useProjects();

const PROJECT_VIEWS: { key: ProjectViewType; label: string; icon: string }[] = [
  { key: 'board', label: 'Board', icon: '▦' },
  { key: 'table', label: 'Table', icon: '▤' },
  { key: 'gantt', label: 'Gantt', icon: '↔' },
  { key: 'calendar', label: 'Calendar', icon: '□' },
  { key: 'list', label: 'List', icon: '☷' },
];
type ProjectsTab = ProjectViewType | 'activity' | 'projects' | 'lanes' | 'knowledge';
const tab = ref<ProjectsTab>('board');
const selectedKnowledgeNodeId = ref('');
const saving = ref(false);
const activity = ref<WorkActivityRecord[]>([]);
const activityLoading = ref(false);
const viewSearch = ref('');
const collapsedEpics = ref(new Set<string>());
const selectedTasks = ref(new Set<string>());
const savedViews = ref<WorkProjectViewRecord[]>([]);
const activeViewId = ref('');
const viewName = ref('');
const saveViewGlobally = ref(false);
const TABLE_RENDER_LIMIT = 500;
const PROJECTION_RENDER_LIMIT = 500;
const isDataView = computed(() => PROJECT_VIEWS.some(view => view.key === tab.value));
let refreshTimer: ReturnType<typeof setInterval> | null = null;
const laneSettings = ref<InstanceType<typeof LaneSettings> | null>(null);
const automationRoles = ['terminal', 'review', 'blocked', 'execution', 'planning', 'backlog', 'manual'] as const;
const automationStatus = ref<{ limits: WipLimits; counts: RoleCounts; decision: BackpressureDecision; at: string } | null>(null);
type ConveyorSnapshot = Awaited<ReturnType<typeof WorkConveyorMetricsModel.snapshot>>;
type HealthItem = Awaited<ReturnType<typeof WorkConveyorMetricsModel.oldestItems>>[number];
const conveyorHealth = ref<ConveyorSnapshot | null>(null);
const conveyorWindow = ref(168);
const healthScopeProject = ref(true);
const healthStage = ref<SemanticStage | null>(null);
const healthItems = ref<HealthItem[]>([]);
const custodyPercent = computed(() => {
  const rows = conveyorHealth.value?.custody ?? [];
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  const complete = rows.reduce((sum, row) => sum + row.structured, 0);
  return percent(total ? complete / total : 0);
});

const selectedLanes = computed(() => selectedId.value ? (lanesByProject.value[selectedId.value] ?? []) : []);
const COMPATIBILITY_LANE_KEYS = ['backlog', 'todo', 'planning', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled', 'parked'];
const STATUSES = computed(() => selectedLanes.value.length
  ? selectedLanes.value.map(lane => lane.lane_key)
  : COMPATIBILITY_LANE_KEYS);
const PRIORITIES = ['critical', 'high', 'medium', 'low'];
// Canonical assignees. Values are the exact lowercase tokens the Projects tools and
// the Heartbeat lane filter match on — 'heartbeat' is what routes work into the
// autonomous agent's queue, so it must stay lowercase and spelled this way.
const ASSIGNEES = [
  { value: 'heartbeat', label: 'Heartbeat (autonomous)' },
  { value: 'sulla', label: 'Sulla' },
  { value: 'human', label: 'Human' },
];
function isKnownAssignee(a: string): boolean {
  return ASSIGNEES.some(x => x.value === a);
}

onMounted(async() => {
  await load().catch((err) => {
    console.error('[ProjectsHome] initial load failed:', err);
  });
  const globalViews = await listViews(null).catch(() => []);
  if (!globalViews.some(view => view.project_id === null && view.is_default)) {
    await saveView({ view_type: 'board', name: 'Default', is_default: true, configuration: {} }).catch(() => undefined);
  }
  await loadAvailableViews();
  await restoreProjectView();
  automationStatus.value = await ipcRenderer.invoke('work-items:automation-status').catch(() => null);
  await loadConveyorHealth();
  refreshTimer = setInterval(() => {
    if (!document.hidden && !saving.value) {
      load().catch(() => undefined);
      ipcRenderer.invoke('work-items:automation-status')
        .then(status => { automationStatus.value = status; })
        .catch(() => undefined);
      loadConveyorHealth().catch(() => undefined);
    }
  }, 15_000);
});

function healthProjectId(): string | null {
  return healthScopeProject.value ? (selectedId.value || null) : null;
}

async function loadConveyorHealth(): Promise<void> {
  conveyorHealth.value = await ipcRenderer.invoke('work-items:conveyor-health', {
    projectId: healthProjectId(), windowHours: conveyorWindow.value,
  }).catch(() => null);
  if (healthStage.value) await loadHealthStage(healthStage.value);
}

async function loadHealthStage(stage: SemanticStage): Promise<void> {
  healthStage.value = stage;
  healthItems.value = await ipcRenderer.invoke('work-items:conveyor-oldest', {
    projectId: healthProjectId(), stage,
  }).catch(() => []);
}

function duration(seconds: number | null): string {
  if (seconds == null) return '-';
  if (seconds < 3600) return `${ Math.max(1, Math.round(seconds / 60)) }m`;
  if (seconds < 86_400) return `${ Math.round(seconds / 3600) }h`;
  return `${ Math.round(seconds / 86_400) }d`;
}

function percent(value: number | null): string { return value == null ? 'unlimited' : `${ Math.round(value * 100) }%`; }

async function openHealthTask(taskId: string): Promise<void> {
  const row = allTasks.value.find(entry => entry.task.id === taskId);
  if (row) await openTaskDrawer(row.task);
}

watch([conveyorWindow, healthScopeProject, selectedId], () => {
  loadConveyorHealth().catch(() => undefined);
});

onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});

async function restoreProjectView(): Promise<void> {
  const saved = await resolveView(selectedId.value).catch(() => null);
  if (!saved) return;
  tab.value = saved.view_type;
  viewSearch.value = saved.configuration.search ?? '';
  collapsedEpics.value = new Set(saved.configuration.collapsedIds ?? []);
  ganttZoom.value = saved.configuration.zoom ?? 'week';
  if (saved.configuration.dateAnchor) {
    dateAnchor.value = saved.configuration.dateAnchor;
    calendarAnchor.value = saved.configuration.dateAnchor;
  }
}

async function loadAvailableViews(): Promise<void> {
  savedViews.value = await listViews(selectedId.value).catch(() => []);
}

function applyViewRecord(saved: WorkProjectViewRecord): void {
  tab.value = saved.view_type;
  viewSearch.value = saved.configuration.search ?? '';
  collapsedEpics.value = new Set(saved.configuration.collapsedIds ?? []);
  ganttZoom.value = saved.configuration.zoom ?? 'week';
  if (saved.configuration.dateAnchor) {
    dateAnchor.value = saved.configuration.dateAnchor;
    calendarAnchor.value = saved.configuration.dateAnchor;
  }
}

function applySavedView(): void {
  const saved = savedViews.value.find(view => view.id === activeViewId.value);
  if (saved) applyViewRecord(saved);
}

async function saveNamedView(): Promise<void> {
  const name = viewName.value.trim();
  if (!name || !isDataView.value) return;
  const saved = await saveView({
    project_id:    saveViewGlobally.value ? null : selectedId.value,
    name,
    view_type:     tab.value as ProjectViewType,
    is_default:    false,
    configuration: {
      search:       viewSearch.value,
      zoom:         ganttZoom.value,
      dateAnchor:   tab.value === 'calendar' ? calendarAnchor.value : dateAnchor.value,
      collapsedIds: [...collapsedEpics.value],
    },
  });
  viewName.value = '';
  await loadAvailableViews();
  activeViewId.value = saved.id;
}

async function setProjectView(view: ProjectViewType): Promise<void> {
  tab.value = view;
  await persistProjectView();
}

async function persistProjectView(): Promise<void> {
  if (!isDataView.value) return;
  await saveView({
    project_id:    selectedId.value,
    name:          'Last used',
    view_type:     tab.value as ProjectViewType,
    is_default:    true,
    configuration: {
      search:        viewSearch.value,
      zoom:          ganttZoom.value,
      dateAnchor:    tab.value === 'calendar' ? calendarAnchor.value : dateAnchor.value,
      collapsedIds:  [...collapsedEpics.value],
      visibleFields: ['title', 'epic', 'status', 'priority', 'assignee', 'start_at', 'due_at'],
    },
  });
}

watch([tab, selectedId], () => {
  if (tab.value === 'activity') {
    refreshActivity().catch((err) => {
      console.error('[ProjectsHome] activity refresh failed:', err);
    });
  }
});

watch(selectedId, () => {
  activeViewId.value = '';
  Promise.all([loadAvailableViews(), restoreProjectView()]).catch(() => undefined);
});
watch(viewSearch, () => persistProjectView().catch(() => undefined));

async function refresh(): Promise<void> {
  await load();
  if (tab.value === 'activity') await refreshActivity();
}

async function refreshActivity(): Promise<void> {
  if (!selectedId.value) {
    activity.value = [];
    return;
  }
  activityLoading.value = true;
  try {
    activity.value = await loadActivity(selectedId.value, 80);
  } finally {
    activityLoading.value = false;
  }
}

function openKnowledgeNode(id: string): void {
  selectedKnowledgeNodeId.value = id;
  tab.value = 'knowledge';
  closeTask();
}

async function openLinkedWork(item: LinkedWorkItemRecord): Promise<void> {
  select(item.project_id_resolved);
  tab.value = 'today';
  if (item.item_kind === 'task') {
    const task = projects.value.flatMap(project => project.epics.flatMap(epic => epic.tasks))
      .find(candidate => candidate.id === item.item_id);
    if (task) await openTaskDrawer(task);
  }
}

// ── grouping for the sidebar ──────────────────────────────────────────
const groups = computed(() => {
  const heartbeat: ProjectView[] = [];
  const stack: ProjectView[] = [];
  const closed: ProjectView[] = [];
  for (const p of projects.value) {
    if (p.status === 'done') closed.push(p);
    else if (isHeartbeat(p)) heartbeat.push(p);
    else stack.push(p);
  }

  return [
    { label: 'Heartbeat’s lane', items: heartbeat },
    { label: 'Your stack', items: stack },
    { label: 'Closed', items: closed },
  ];
});

function isHeartbeat(p: ProjectView): boolean {
  return p.slug === 'goal-operator-transition' || /operator platform/i.test(p.title);
}
function laneLabel(p: ProjectView): string {
  if (p.status === 'done') return 'Closed';
  if (isHeartbeat(p)) return 'Heartbeat lane';

  return 'Your stack';
}

// ── display helpers ───────────────────────────────────────────────────
function shortName(p: ProjectView): string {
  return p.title.split(' (')[0].split(' — ')[0].trim();
}
function dotClass(p: ProjectView): string {
  if (p.status === 'done') return 'done';
  if (p.status === 'blocked') return 'block';
  if (p.status === 'backlog') return 'hold';

  return 'go';
}

const CLEAN_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
function cleanTitle(raw: string): string {
  let s = (raw || '').replace(/[&<>]/g, c => CLEAN_ESC[c]);
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/`([^`]+?)`/g, '<code>$1</code>');

  return s;
}

function laneForStatus(status: string) {
  return selectedLanes.value.find(lane => lane.lane_key === status);
}
function semanticRole(status: string): string {
  return laneForStatus(status)?.semantic_role ?? 'manual';
}
function isBlockedStatus(status: string): boolean {
  return semanticRole(status) === 'blocked';
}
function markClass(status: string): string {
  const role = semanticRole(status);
  if (role === 'blocked') return 'wait';
  if (role === 'terminal' || role === 'manual') return 'gray';
  return 'hi';
}

function statusLabel(status: string): string {
  return laneForStatus(status)?.display_name ?? status;
}
function showPriority(pr: string): boolean {
  return pr === 'high' || pr === 'critical' || pr === 'p0' || pr === 'p1';
}
function epicSummary(epic: EpicWithTasks): string {
  let open = 0;
  let done = 0;
  for (const t of epic.tasks) {
    if (t.lane?.semantic_role === 'terminal') done++;
    else open++;
  }
  const parts: string[] = [];
  if (open) parts.push(`${ open } open`);
  if (done) parts.push(`${ done } done`);

  return parts.join(' · ') || 'empty';
}
function pct(p: ProjectView): number {
  const total = p.openCount + p.doneCount;

  return total ? Math.round((100 * p.doneCount) / total) : 0;
}
function progClass(p: ProjectView): string {
  if (p.status === 'blocked') return 'amber';
  if (p.status === 'backlog' || p.status === 'done') return 'gray';

  return '';
}
function shortDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);

  return `${ d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) } ${ d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) }`;
}

// ── board columns for the selected project ────────────────────────────
type Task = TaskView;
const boardColumns = computed(() => {
  const tasks: Task[] = boundedVisibleTasks.value.map(row => row.task);
  const known = new Set(selectedLanes.value.map(lane => lane.lane_key));
  const columns = selectedLanes.value.map(lane => ({
    key:   lane.lane_key,
    label: lane.display_name,
    color: lane.color || (lane.semantic_role === 'blocked' ? 'var(--pamber)' : lane.semantic_role === 'terminal' ? 'var(--ptext3)' : 'var(--pacc)'),
    items: tasks.filter(task => task.status === lane.lane_key),
  }));
  for (const status of new Set(tasks.filter(task => !known.has(task.status)).map(task => task.status))) {
    columns.push({ key: status, label: status, color: 'var(--ptext3)', items: tasks.filter(task => task.status === status) });
  }
  return columns;
});

interface ProjectTaskRow { task: TaskView; epic: EpicWithTasks }
const allTasks = computed<ProjectTaskRow[]>(() => (sel.value?.epics ?? []).flatMap(epic => epic.tasks.map(task => ({ task, epic }))));
const visibleTasks = computed(() => {
  const needle = viewSearch.value.trim().toLowerCase();
  return needle
    ? allTasks.value.filter(({ task, epic }) =>
      `${ task.title } ${ task.description } ${ task.status } ${ task.priority } ${ task.assignee ?? '' } ${ epic.title }`.toLowerCase().includes(needle))
    : allTasks.value;
});
const boundedVisibleTasks = computed(() => visibleTasks.value.slice(0, PROJECTION_RENDER_LIMIT));
function filteredEpicTasks(epic: EpicWithTasks): TaskView[] {
  return boundedVisibleTasks.value.filter(row => row.epic.id === epic.id).map(row => row.task);
}
function toggleEpic(id: string): void {
  const next = new Set(collapsedEpics.value);
  next.has(id) ? next.delete(id) : next.add(id);
  collapsedEpics.value = next;
  persistProjectView().catch(() => undefined);
}
function toggleSelection(id: string): void {
  const next = new Set(selectedTasks.value);
  next.has(id) ? next.delete(id) : next.add(id);
  selectedTasks.value = next;
}
function inputValue(event: Event): string { return (event.target as HTMLInputElement).value }
async function inlineTaskField(task: TaskView, field: 'status' | 'priority' | 'assignee' | 'start_at' | 'due_at' | 'milestone_at', value: string | null): Promise<void> {
  await updateTask(task.id, { [field]: value, actor: 'human' });
}

type GanttZoom = 'day' | 'week' | 'month';
const todayYmd = new Date().toISOString().slice(0, 10);
const ganttZoom = ref<GanttZoom>('week');
const dateAnchor = ref(todayYmd);
const scheduledTasks = computed(() => boundedVisibleTasks.value.filter(({ task }) => task.start_at || task.due_at || task.milestone_at));
const unscheduledTasks = computed(() => boundedVisibleTasks.value.filter(({ task }) => !task.start_at && !task.due_at && !task.milestone_at));
const ganttRange = computed(() => {
  const dates = scheduledTasks.value.flatMap(({ task }) => [task.start_at, task.due_at, task.milestone_at].filter(Boolean).map(v => new Date(v!).getTime()));
  const today = new Date(todayYmd).getTime();
  const pad = ganttZoom.value === 'day' ? 3 : ganttZoom.value === 'week' ? 14 : 45;
  const day = 86_400_000;
  return { min: Math.min(today, ...dates) - pad * day, max: Math.max(today, ...dates) + pad * day };
});
const ganttTodayOffset = computed(() => 100 * (new Date(todayYmd).getTime() - ganttRange.value.min) / (ganttRange.value.max - ganttRange.value.min));
function ganttStyle(task: TaskView): Record<string, string> {
  const start = new Date(task.start_at || task.milestone_at || task.due_at!).getTime();
  const end = new Date(task.due_at || task.milestone_at || task.start_at!).getTime();
  const span = ganttRange.value.max - ganttRange.value.min;
  return { left: `${ 100 * (Math.min(start, end) - ganttRange.value.min) / span }%`, width: `${ Math.max(0.8, 100 * Math.max(86_400_000, Math.abs(end - start)) / span) }%` };
}
function setZoom(zoom: string): void { ganttZoom.value = zoom as GanttZoom; persistProjectView().catch(() => undefined) }

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const calendarAnchor = ref(todayYmd);
const calendarDragId = ref('');
const calendarTitle = computed(() => new Date(`${ calendarAnchor.value }T12:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
const calendarDays = computed(() => {
  const anchor = new Date(`${ calendarAnchor.value }T12:00:00`);
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = new Date(first); start.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, offset) => {
    const date = new Date(start); date.setDate(start.getDate() + offset);
    return { ymd: date.toISOString().slice(0, 10), day: date.getDate(), inMonth: date.getMonth() === anchor.getMonth() };
  });
});
function tasksForDate(date: string): ProjectTaskRow[] {
  return boundedVisibleTasks.value.filter(({ task }) => ymd(task.milestone_at || task.due_at || task.start_at) === date);
}
function shiftMonth(delta: number): void {
  const date = new Date(`${ calendarAnchor.value }T12:00:00`); date.setMonth(date.getMonth() + delta); calendarAnchor.value = date.toISOString().slice(0, 10); persistProjectView().catch(() => undefined);
}
async function dropOnDate(date: string): Promise<void> {
  const task = allTasks.value.find(row => row.task.id === calendarDragId.value)?.task;
  calendarDragId.value = '';
  if (task) await inlineTaskField(task, task.milestone_at ? 'milestone_at' : 'due_at', isoFromYmd(date));
}

function openLaneEditor(laneKey: string): void {
  const lane = selectedLanes.value.find(item => item.lane_key === laneKey);
  if (!lane) return;
  tab.value = 'lanes';
  laneSettings.value?.openEdit(lane);
}

function openLaneAssignment(laneKey: string): void {
  const lane = selectedLanes.value.find(item => item.lane_key === laneKey);
  if (!lane) return;
  laneSettings.value?.openAssignment(lane);
}

// ══════════ DRAG TO REORDER ══════════
// Native HTML5 DnD. A drag carries { kind, id, fromEpicId }; on drop we rebuild
// the affected list, stamp position = index, and send one reorder() batch
// (which also carries status for board moves and epic_id for cross-epic moves).
const dnd = reactive<{ kind: 'task' | 'epic' | null; id: string; fromEpicId: string }>({ kind: null, id: '', fromEpicId: '' });
const dragOverTaskId = ref('');
const dragOverEpicId = ref('');
const dragOverCol = ref('');

function onDragStartTask(t: WorkTaskRecord, epicId: string | null, ev: DragEvent): void {
  dnd.kind = 'task';
  dnd.id = t.id;
  dnd.fromEpicId = epicId ?? '';
  if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
}
function onDragStartEpic(epic: EpicWithTasks, ev: DragEvent): void {
  dnd.kind = 'epic';
  dnd.id = epic.id;
  if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
}
function onDragEnd(): void {
  dnd.kind = null; dnd.id = ''; dnd.fromEpicId = '';
  dragOverTaskId.value = ''; dragOverEpicId.value = ''; dragOverCol.value = '';
}

/** Drop a dragged task into `targetEpic`, positioned before `beforeId` (or at end). */
async function moveTaskInto(targetEpic: EpicWithTasks, beforeId: string | null): Promise<void> {
  const draggedId = dnd.id;
  const fromEpicId = dnd.fromEpicId;
  if (dnd.kind !== 'task' || !draggedId) return;
  const rest = targetEpic.tasks.filter(t => t.id !== draggedId);
  let idx = beforeId ? rest.findIndex(t => t.id === beforeId) : rest.length;
  if (idx === -1) idx = rest.length;
  const ids = rest.map(t => t.id);
  ids.splice(idx, 0, draggedId);
  const crossEpic = fromEpicId !== targetEpic.id;
  const updates: ReorderUpdate[] = ids.map((id, i) => ({
    kind: 'task', id, position: i, ...(id === draggedId && crossEpic ? { epic_id: targetEpic.id } : {}),
  }));
  onDragEnd();
  await reorder(updates);
}

async function onRowDrop(target: WorkTaskRecord, epic: EpicWithTasks): Promise<void> {
  if (dnd.kind === 'task') await moveTaskInto(epic, target.id);
}

async function onSectionDrop(epic: EpicWithTasks): Promise<void> {
  if (dnd.kind === 'task') {
    await moveTaskInto(epic, null);          // append to this epic
  } else if (dnd.kind === 'epic' && sel.value) {
    const draggedId = dnd.id;
    const rest = sel.value.epics.filter(e => e.id !== draggedId);
    let idx = rest.findIndex(e => e.id === epic.id);
    if (idx === -1) idx = rest.length;
    const ids = rest.map(e => e.id);
    ids.splice(idx, 0, draggedId);
    const updates: ReorderUpdate[] = ids.map((id, i) => ({ kind: 'epic', id, position: i }));
    onDragEnd();
    await reorder(updates);
  }
}

async function onColumnDrop(colKey: string): Promise<void> {
  if (dnd.kind !== 'task') return;
  const id = dnd.id;
  onDragEnd();
  if (colKey) await reorder([{ kind: 'task', id, status: colKey }]);
}

// ══ date helpers ══
function ymd(iso?: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}
function isoFromYmd(v: string): string | null {
  return v ? new Date(`${ v }T00:00:00`).toISOString() : null;
}

// ══════════ TASK DRAWER ══════════
type TaskDraft = UpsertTaskInput & { id?: string };
const openTask = ref<WorkTaskRecord | null>(null);
const taskMode = ref<'edit' | 'create'>('edit');
const taskDraft = reactive<TaskDraft>({ title: '' });
const taskComments = ref<WorkCommentRecord[]>([]);
const taskDependencies = ref<WorkTaskDependencyRecord[]>([]);
const dependencyCandidate = ref('');
const newComment = ref('');
const receiptEvidence = reactive<Record<string, string>>({});

function isArtifactReceipt(body: string): boolean {
  return body.includes('<!-- artifact-receipt');
}

async function toggleReceiptEvidence(commentId: string): Promise<void> {
  if (receiptEvidence[commentId]) {
    delete receiptEvidence[commentId];
    return;
  }
  const result = await ipcRenderer.invoke('work-items:artifact-evidence', commentId);
  receiptEvidence[commentId] = JSON.stringify(result?.evidence ?? result?.receipt ?? { unavailable: true }, null, 2);
}

const taskDueYmd = computed<string>({
  get: () => ymd(taskDraft.due_at),
  set: (v: string) => { taskDraft.due_at = isoFromYmd(v) },
});
const taskStartYmd = computed<string>({ get: () => ymd(taskDraft.start_at), set: v => { taskDraft.start_at = isoFromYmd(v) } });
const taskMilestoneYmd = computed<string>({ get: () => ymd(taskDraft.milestone_at), set: v => { taskDraft.milestone_at = isoFromYmd(v) } });

function fillTaskDraft(t: Partial<WorkTaskRecord> & { epic_id?: string | null }): void {
  taskDraft.id = (t as WorkTaskRecord).id;
  taskDraft.title = t.title ?? '';
  taskDraft.description = t.description ?? '';
  taskDraft.status = t.status ?? 'todo';
  taskDraft.priority = t.priority ?? 'medium';
  taskDraft.epic_id = t.epic_id ?? (sel.value?.epics[0]?.id ?? null);
  taskDraft.assignee = t.assignee ?? '';
  taskDraft.due_at = t.due_at ?? null;
  taskDraft.start_at = t.start_at ?? null;
  taskDraft.milestone_at = t.milestone_at ?? null;
  taskDraft.github_issue = t.github_issue ?? '';
}

async function openTaskDrawer(t: WorkTaskRecord): Promise<void> {
  taskMode.value = 'edit';
  openTask.value = t;
  fillTaskDraft(t);
  [taskComments.value, taskDependencies.value] = await Promise.all([
    loadComments(t.id),
    listTaskDependencies(t.project_id),
  ]);
  dependencyCandidate.value = '';
}

const currentDependencies = computed(() => taskDependencies.value
  .filter(dependency => dependency.task_id === taskDraft.id));
const dependencyCandidates = computed(() => {
  const existing = new Set(currentDependencies.value.map(dependency => dependency.depends_on_task_id));
  return allTasks.value
    .map(row => row.task)
    .filter(task => task.id !== taskDraft.id && !existing.has(task.id));
});
function taskTitle(id: string): string {
  return allTasks.value.find(row => row.task.id === id)?.task.title ?? id;
}
async function addDependency(): Promise<void> {
  if (!taskDraft.id || !dependencyCandidate.value || !selectedId.value) return;
  await setTaskDependency(taskDraft.id, dependencyCandidate.value);
  taskDependencies.value = await listTaskDependencies(selectedId.value);
  dependencyCandidate.value = '';
}
async function removeDependency(dependsOnTaskId: string): Promise<void> {
  if (!taskDraft.id || !selectedId.value) return;
  await removeTaskDependency(taskDraft.id, dependsOnTaskId);
  taskDependencies.value = await listTaskDependencies(selectedId.value);
}

async function openActivityTask(item: WorkActivityRecord): Promise<void> {
  if (!item.task_id) return;
  const task = sel.value?.epics
    .flatMap(epic => epic.tasks)
    .find(t => t.id === item.task_id);
  if (task) await openTaskDrawer(task);
}

const ACTIVITY_KIND_LABELS: Record<WorkActivityRecord['kind'], string> = {
  comment:          'Comment',
  task_created:     'New task',
  task_updated:     'Task edited',
  task_moved:       'Status',
  epic_created:     'New epic',
  epic_updated:     'Epic edited',
  project_created:  'New project',
  project_updated:  'Project edited',
};

function activityKindLabel(kind: WorkActivityRecord['kind']): string {
  return ACTIVITY_KIND_LABELS[kind] ?? 'Activity';
}

function normalizeActivityActor(author: string | null): string {
  const actor = (author || 'sulla').trim().toLowerCase();
  if (!actor || actor === 'agent') return 'sulla';
  return actor;
}

function activityActorLabel(item: WorkActivityRecord): string {
  const actor = normalizeActivityActor(item.author);
  if (actor === 'heartbeat') return 'Heartbeat';
  if (actor === 'human') return 'You';
  if (actor === 'sulla') return 'Sulla';
  if (actor === 'workbench') return 'Workbench';
  return actor.charAt(0).toUpperCase() + actor.slice(1);
}

function activityActorClass(item: WorkActivityRecord): string {
  const actor = normalizeActivityActor(item.author);
  if (actor === 'heartbeat') return 'heartbeat';
  if (actor === 'human') return 'human';
  if (actor === 'workbench') return 'workbench';
  if (actor === 'sulla') return 'sulla';
  return 'other';
}

/** The headline for a row — the subject item's title, whatever level it lives at. */
function activityTitle(item: WorkActivityRecord): string {
  if (item.task_title) return item.task_title;
  if (item.epic_title) return item.epic_title;
  return item.project_title;
}

/** Body text: real comment bodies, or a short synthesized description for lifecycle events. */
function activityText(item: WorkActivityRecord): string {
  if (item.kind === 'comment') return item.body ?? '';
  const status = statusLabel(item.task_status);
  switch (item.kind) {
  case 'task_created': return 'Task added to Projects.';
  case 'task_moved': return `Moved to ${ status }.`;
  case 'task_updated': return 'Task details updated.';
  case 'epic_created': return 'Epic created.';
  case 'epic_updated': return `Epic updated · ${ status }.`;
  case 'project_created': return 'Project created.';
  case 'project_updated': return `Project updated · ${ status }.`;
  default: return '';
  }
}

function openNewTask(epicId: string): void {
  taskMode.value = 'create';
  openTask.value = { id: '' } as WorkTaskRecord;
  fillTaskDraft({ epic_id: epicId, status: 'todo', priority: 'medium' });
  taskComments.value = [];
  taskDependencies.value = [];
  dependencyCandidate.value = '';
}

function closeTask(): void {
  openTask.value = null;
  newComment.value = '';
}

async function saveTask(): Promise<void> {
  if (!taskDraft.title) return;
  saving.value = true;
  try {
    if (taskMode.value === 'create') {
      await createTask({
        epic_id:      taskDraft.epic_id ?? undefined,
        title:        taskDraft.title,
        description:  taskDraft.description,
        status:       taskDraft.status,
        priority:     taskDraft.priority,
        assignee:     taskDraft.assignee || null,
        due_at:       taskDraft.due_at ?? null,
        start_at:     taskDraft.start_at ?? null,
        milestone_at: taskDraft.milestone_at ?? null,
        github_issue: taskDraft.github_issue || null,
      });
    } else if (taskDraft.id) {
      await updateTask(taskDraft.id, {
        epic_id:      taskDraft.epic_id ?? undefined,
        title:        taskDraft.title,
        description:  taskDraft.description,
        status:       taskDraft.status,
        priority:     taskDraft.priority,
        assignee:     taskDraft.assignee || null,
        due_at:       taskDraft.due_at ?? null,
        start_at:     taskDraft.start_at ?? null,
        milestone_at: taskDraft.milestone_at ?? null,
        github_issue: taskDraft.github_issue || null,
      });
    }
    closeTask();
  } finally {
    saving.value = false;
  }
}

async function confirmArchiveTask(): Promise<void> {
  if (!taskDraft.id) return;
  if (!window.confirm('Archive this issue? It will be hidden from the board (soft-delete).')) return;
  saving.value = true;
  try {
    await archiveTask(taskDraft.id);
    closeTask();
  } finally {
    saving.value = false;
  }
}

async function postComment(): Promise<void> {
  const body = newComment.value.trim();
  if (!body || !taskDraft.id) return;
  saving.value = true;
  try {
    await addComment(taskDraft.id, body, 'human');
    taskComments.value = await loadComments(taskDraft.id);
    if (tab.value === 'activity') await refreshActivity();
    newComment.value = '';
  } finally {
    saving.value = false;
  }
}

// ══════════ PROJECT MODAL ══════════
type ProjectDraft = UpsertProjectInput & { id?: string };
const projectModal = reactive<{ open: boolean; mode: 'create' | 'edit' }>({ open: false, mode: 'create' });
const projectDraft = reactive<ProjectDraft>({ title: '' });

function openNewProject(): void {
  projectModal.mode = 'create';
  Object.assign(projectDraft, {
    id: undefined, title: '', description: '', status: 'backlog', priority: 'medium', owner: '', github_repo: '', outcome_metric: '',
  });
  projectModal.open = true;
}
function openEditProject(p: ProjectView): void {
  projectModal.mode = 'edit';
  Object.assign(projectDraft, {
    id:             p.id,
    title:          p.title,
    description:    p.description,
    status:         p.status,
    priority:       p.priority,
    owner:          p.owner ?? '',
    github_repo:    p.github_repo ?? '',
    outcome_metric: p.outcome_metric ?? '',
  });
  projectModal.open = true;
}
async function saveProject(): Promise<void> {
  if (!projectDraft.title) return;
  saving.value = true;
  try {
    if (projectModal.mode === 'create') {
      await createProject({
        title:          projectDraft.title,
        description:    projectDraft.description,
        status:         projectDraft.status,
        priority:       projectDraft.priority,
        owner:          projectDraft.owner || null,
        github_repo:    projectDraft.github_repo || null,
        outcome_metric: projectDraft.outcome_metric || null,
      });
    } else if (projectDraft.id) {
      await updateProject(projectDraft.id, {
        title:          projectDraft.title,
        description:    projectDraft.description,
        status:         projectDraft.status,
        priority:       projectDraft.priority,
        owner:          projectDraft.owner || null,
        github_repo:    projectDraft.github_repo || null,
        outcome_metric: projectDraft.outcome_metric || null,
      });
    }
    projectModal.open = false;
  } finally {
    saving.value = false;
  }
}
async function confirmArchiveProject(p: ProjectView): Promise<void> {
  if (!window.confirm(`Archive "${ shortName(p) }" and all its epics and issues? (soft-delete)`)) return;
  saving.value = true;
  try {
    await archiveProject(p.id);
  } finally {
    saving.value = false;
  }
}

// ══════════ EPIC MODAL ══════════
type EpicDraft = UpsertEpicInput & { id?: string };
const epicModal = reactive<{ open: boolean; mode: 'create' | 'edit' }>({ open: false, mode: 'create' });
const epicDraft = reactive<EpicDraft>({ project_id: '', title: '' });

function openNewEpic(projectId: string): void {
  epicModal.mode = 'create';
  Object.assign(epicDraft, { id: undefined, project_id: projectId, title: '', description: '', status: 'todo', priority: 'medium' });
  epicModal.open = true;
}
function openEditEpic(e: EpicWithTasks): void {
  epicModal.mode = 'edit';
  Object.assign(epicDraft, { id: e.id, project_id: e.project_id, title: e.title, description: e.description, status: e.status, priority: e.priority });
  epicModal.open = true;
}
async function saveEpic(): Promise<void> {
  if (!epicDraft.title) return;
  saving.value = true;
  try {
    if (epicModal.mode === 'create') {
      await createEpic({
        project_id:  epicDraft.project_id,
        title:       epicDraft.title,
        description: epicDraft.description,
        status:      epicDraft.status,
        priority:    epicDraft.priority,
      });
    } else if (epicDraft.id) {
      await updateEpic(epicDraft.id, {
        title: epicDraft.title, description: epicDraft.description, status: epicDraft.status, priority: epicDraft.priority,
      });
    }
    epicModal.open = false;
  } finally {
    saving.value = false;
  }
}
async function confirmArchiveEpic(e: EpicWithTasks): Promise<void> {
  if (!window.confirm(`Archive epic "${ e.title }" and its issues? (soft-delete)`)) return;
  saving.value = true;
  try {
    await archiveEpic(e.id);
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped lang="scss">
@import '@pkg/assets/styles/routines-theme.scss';

.projects-home {
  @include routines-theme-vars;

  --pbg:          #0b0f17;
  --psurface:     #11161f;
  --psurface2:    #161c27;
  --pborder:      #212a38;
  --pborder-soft: #1a212d;
  --ptext:        var(--text, #eef2f8);
  --ptext2:       #9aa7b8;
  --ptext3:       #7f8da0;
  --pacc:         var(--steel-400, #5096b3);
  --pacc-soft:    rgba(80, 150, 179, 0.14);
  --pacc-line:    rgba(80, 150, 179, 0.40);
  --pgreen:       #5ba37d;
  --pamber:       #c99a54;
  --pred:         #c9736f;
  --pserif:       var(--serif, 'Playfair Display', Georgia, serif);
  --pmono:        var(--mono, ui-monospace, 'JetBrains Mono', Menlo, monospace);
  --psans:        var(--sans, 'Inter', system-ui, sans-serif);

  height: 100%;
  min-height: 0;
  position: relative;
  background: var(--pbg);
  color: var(--ptext);
  font-family: var(--psans);
}
:global(html.light) .projects-home, :global(body.light) .projects-home {
  --pbg: #f5f7fa; --psurface: #ffffff; --psurface2: #edf1f5;
  --pborder: #c5ced8; --pborder-soft: #dce2e8;
  --ptext: #17212b; --ptext2: #4d5e6f; --ptext3: #5b6d7e;
  --pacc-soft: rgba(46, 111, 140, 0.12); --pacc-line: rgba(46, 111, 140, 0.48); --pacc: #2e6f8c;
  --pgreen: #347558; --pamber: #8b611f; --pred: #a34641;
}
.projects-home * { box-sizing: border-box; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.projects-home code { font-family: var(--pmono); font-size: 0.85em; color: #b9d3df; }

.ph-body { display: flex; height: 100%; min-height: 0; }

/* buttons */
.ph-btn {
  font-family: var(--psans); font-size: 12.5px; font-weight: 500; color: var(--ptext);
  background: var(--pacc-soft); border: 1px solid var(--pacc-line); border-radius: 8px;
  padding: 7px 12px; cursor: pointer; white-space: nowrap;
}
.ph-btn:hover { background: rgba(80, 150, 179, 0.22); }
.ph-btn:disabled { opacity: 0.5; cursor: default; }
.ph-btn.primary { background: var(--pacc); border-color: var(--pacc); color: #06121a; }
.ph-btn.ghost { background: transparent; border-color: var(--pborder); color: var(--ptext2); }
.ph-btn.ghost:hover { color: var(--ptext); border-color: var(--pacc-line); background: rgba(255, 255, 255, 0.03); }
.ph-btn.block { width: 100%; }
.ph-btn.sm { padding: 5px 10px; font-size: 12px; }
.ph-btn.xs { padding: 3px 8px; font-size: 11px; border-radius: 6px; }
.ph-btn.danger { color: var(--pred); border-color: rgba(201, 115, 111, 0.35); }
.ph-btn.danger:hover { color: #e59a96; border-color: rgba(201, 115, 111, 0.6); background: rgba(201, 115, 111, 0.08); }

/* sidebar */
.ph-side { width: 248px; flex-shrink: 0; border-right: 1px solid var(--pborder); background: var(--psurface); display: flex; flex-direction: column; min-height: 0; }
.ph-side-h { padding: 22px 20px 10px; }
.ph-eyebrow { font-family: var(--pmono); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--pacc); margin-bottom: 6px; }
.ph-side-h h1 { font-family: var(--pserif); font-weight: 500; font-size: 24px; margin: 0; color: var(--ptext); }
.ph-list { padding: 6px 12px 12px; overflow: auto; min-height: 0; flex: 1; }
.ph-side-f { padding: 10px 12px 14px; border-top: 1px solid var(--pborder-soft); }
.ph-grp { font-family: var(--pmono); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ptext3); padding: 14px 8px 6px; }
.ph-p { display: block; width: 100%; text-align: left; padding: 9px 10px; border-radius: 9px; margin-bottom: 2px; border: 1px solid transparent; background: transparent; cursor: pointer; color: var(--ptext); }
.ph-p:hover { background: rgba(255, 255, 255, 0.03); }
.ph-p.on { background: var(--pacc-soft); border-color: var(--pacc-line); }
.ph-pn { font-size: 13.5px; font-weight: 500; display: flex; align-items: center; gap: 8px; }
.ph-st { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.ph-st.go { background: var(--pacc); }
.ph-st.hold { background: var(--ptext3); }
.ph-st.block { background: var(--pamber); }
.ph-st.done { background: var(--pgreen); }
.ph-pc { display: block; font-size: 11.5px; color: var(--ptext3); margin: 4px 0 0 15px; }

/* main */
.ph-main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.ph-top { display: flex; align-items: center; gap: 16px; padding: 18px 26px; border-bottom: 1px solid var(--pborder); }
.ph-tabs { display: flex; gap: 18px; overflow-x: auto; }
.ph-tab { font-family: var(--psans); font-size: 14px; color: var(--ptext3); padding: 0 0 4px; cursor: pointer; border: none; background: transparent; border-bottom: 2px solid transparent; }
.ph-tab:hover { color: var(--ptext2); }
.ph-tab.on { color: var(--ptext); border-bottom-color: var(--pacc); }
.ph-view-tab { display: inline-flex; gap: 5px; align-items: center; }
.ph-search input { width: 190px; background: var(--psurface2); border: 1px solid var(--pborder); color: var(--ptext); border-radius: 7px; padding: 7px 10px; font-size: 12px; }
.ph-view-presets { display: flex; align-items: center; gap: 6px; }
.ph-view-presets select, .ph-view-presets input { max-width: 150px; background: var(--psurface2); border: 1px solid var(--pborder); color: var(--ptext); border-radius: 7px; padding: 7px 8px; font-size: 11px; }
.ph-check { display: inline-flex; align-items: center; gap: 4px; color: var(--ptext2); font-size: 11px; }
.ph-search input:focus, .ph-view-presets input:focus, .ph-view-presets select:focus, .ph-tab:focus-visible, .ph-btn:focus-visible, .ph-link:focus-visible { outline: 2px solid var(--pacc); outline-offset: 2px; }
.ph-card:focus-visible, .ph-row:focus-visible, .ph-gantt-label:focus-visible, .ph-gantt-dates input:focus-visible, .ph-calendar button:focus-visible { outline: 2px solid var(--pacc); outline-offset: 2px; }
.ph-sp { flex: 1; }

.ph-canvas { flex: 1; overflow: auto; padding: 26px 28px 36px; min-height: 0; }
.ph-state { color: var(--ptext2); font-size: 14px; padding: 20px 2px; }
.ph-err b { color: var(--ptext); display: block; margin-bottom: 6px; }
.ph-err p { color: var(--pamber); font-family: var(--pmono); font-size: 12px; margin: 0 0 12px; }
.ph-muted { color: var(--ptext3); font-size: 13px; padding: 4px 2px 10px; }
.ph-actions { display: flex; gap: 6px; }

/* today */
.ph-lead { margin: 0 0 26px; }
.ph-lead-row { display: flex; align-items: flex-start; gap: 16px; }
.ph-lead h2 { font-family: var(--pserif); font-weight: 500; font-size: 26px; margin: 0 0 8px; line-height: 1.25; color: var(--ptext); flex: 1; }
.ph-lead p { margin: 0; color: var(--ptext2); font-size: 14px; line-height: 1.6; max-width: 640px; }
.ph-lead-meta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.ph-pill { font-family: var(--pmono); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ptext2); border: 1px solid var(--pborder); border-radius: 5px; padding: 2px 8px; }
.ph-pill.hb { color: var(--pacc); border-color: var(--pacc-line); background: var(--pacc-soft); }
.ph-sec { margin-bottom: 30px; }
.ph-sec-h { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
.ph-sec-h h3 { font-size: 13px; font-weight: 600; letter-spacing: 0.02em; margin: 0; color: var(--ptext); }
.ph-collapse { width: 22px; height: 22px; border: 0; background: transparent; color: var(--ptext2); cursor: pointer; }
.ph-cnt { font-family: var(--pmono); font-size: 11px; color: var(--ptext3); }
.ph-row { display: flex; align-items: flex-start; gap: 14px; padding: 14px 16px; border: 1px solid var(--pborder-soft); border-radius: 11px; background: var(--psurface); margin-bottom: 8px; cursor: pointer; }
.ph-row:hover { border-color: var(--pborder); }
.ph-row.sel { border-color: var(--pacc-line); background: var(--pacc-soft); }
.ph-row.subtask { margin-left: 28px; border-left: 2px solid var(--pacc-line); }
.ph-subtask-mark { color: var(--ptext3); font-size: 13px; }
.ph-mark { width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; flex-shrink: 0; }
.ph-mark.hi { background: var(--pacc); }
.ph-mark.wait { background: var(--pamber); }
.ph-mark.gray { background: var(--ptext3); }
.ph-rbody { flex: 1; min-width: 0; }
.ph-t { font-size: 14.5px; font-weight: 500; color: var(--ptext); line-height: 1.4; }
.ph-m { font-family: var(--pmono); font-size: 11px; color: var(--ptext3); margin-top: 8px; text-transform: uppercase; letter-spacing: 0.06em; }
.ph-tag { font-family: var(--pmono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ptext3); border: 1px solid var(--pborder); border-radius: 5px; padding: 3px 8px; white-space: nowrap; align-self: flex-start; }
.ph-tag.wait { color: var(--pamber); border-color: rgba(201, 154, 84, 0.35); }

/* drag-to-reorder affordances */
.ph-row { cursor: pointer; }
.ph-row:active { cursor: grabbing; }
.ph-grip { color: var(--ptext3); font-size: 12px; margin-top: 3px; cursor: grab; opacity: 0; transition: opacity 0.12s ease; flex-shrink: 0; user-select: none; }
.ph-row:hover .ph-grip { opacity: 0.6; }
.ph-row.drop { border-color: var(--pacc); box-shadow: inset 0 2px 0 var(--pacc); }
.ph-drag { color: var(--ptext3); font-size: 12px; cursor: grab; user-select: none; opacity: 0.5; margin-right: 2px; }
.ph-drag:hover { opacity: 1; color: var(--ptext2); }
.ph-sec.drop-epic { outline: 1px dashed var(--pacc-line); outline-offset: 6px; border-radius: 8px; }
.ph-dropzone { border: 1px dashed var(--pborder); border-radius: 9px; text-align: center; padding: 12px; }

/* board */
.ph-cols { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
.ph-col { border: 1px solid transparent; border-radius: 12px; padding: 6px; min-height: 120px; transition: background 0.12s ease, border-color 0.12s ease; }
.ph-col.drop-col { border-color: var(--pacc-line); background: var(--pacc-soft); }
.ph-card[draggable="true"] { cursor: grab; }
.ph-card[draggable="true"]:active { cursor: grabbing; }
.ph-colh { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; font-size: 12px; font-weight: 600; color: var(--ptext2); }
.ph-lane-action { border: 0; background: transparent; color: var(--ptext3); font: 9px var(--pmono); cursor: pointer; padding: 2px; text-transform: uppercase; }
.ph-lane-action:hover, .ph-lane-action:focus-visible { color: var(--pacc); outline: none; }
.ph-cd { width: 7px; height: 7px; border-radius: 50%; }
.ph-n { font-family: var(--pmono); font-size: 11px; color: var(--ptext3); }
.ph-card { background: var(--psurface); border: 1px solid var(--pborder-soft); border-radius: 10px; padding: 12px 13px; margin-bottom: 9px; cursor: pointer; }
.ph-card:hover { border-color: var(--pborder); }
.ph-card select { width: 100%; margin-top: 8px; border: 1px solid var(--pborder-soft); border-radius: 5px; background: var(--psurface2); color: var(--ptext2); font-size: 10px; padding: 4px 5px; }
.ph-card.ghost { border-style: dashed; background: transparent; cursor: default; }
.ph-ct { font-size: 13px; font-weight: 500; line-height: 1.4; color: var(--ptext); }
.ph-card.ghost .ph-ct { color: var(--ptext3); font-weight: 400; font-size: 12.5px; }
.ph-cm { font-family: var(--pmono); font-size: 10.5px; color: var(--ptext3); margin-top: 8px; text-transform: uppercase; letter-spacing: 0.06em; }
.ph-automation-health { margin: 0 0 14px; padding: 10px 12px; border: 1px solid var(--pacc-line); border-radius: 9px; background: var(--pacc-soft); color: var(--ptext2); font-size: 12px; }
.ph-automation-health.held { border-color: color-mix(in srgb, var(--pamber) 55%, transparent); background: color-mix(in srgb, var(--pamber) 10%, transparent); }
.ph-automation-stages { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.ph-health { margin: 0 0 20px; padding: 13px; border: 1px solid var(--pborder); border-radius: 11px; background: var(--psurface); }
.ph-health-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--ptext2); font-size: 12px; }
.ph-health-head b { color: var(--ptext); }
.ph-health-controls { display: flex; align-items: center; gap: 8px; font-size: 10px; color: var(--ptext3); }
.ph-health-controls label { display: inline-flex; align-items: center; gap: 4px; }
.ph-health-controls select { border: 1px solid var(--pborder); border-radius: 5px; background: var(--psurface2); color: var(--ptext2); padding: 4px 6px; font-size: 10px; }
.ph-health-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 7px; margin-top: 11px; }
.ph-health-stat { min-width: 0; padding: 8px 9px; border: 1px solid var(--pborder-soft); border-radius: 7px; background: var(--psurface2); color: var(--ptext2); text-align: left; }
button.ph-health-stat { cursor: pointer; }
button.ph-health-stat:hover, button.ph-health-stat.on { border-color: var(--pacc-line); background: var(--pacc-soft); }
.ph-health-stat span, .ph-health-stat small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 9px var(--pmono); color: var(--ptext3); text-transform: uppercase; }
.ph-health-stat b { display: block; margin: 4px 0 2px; color: var(--ptext); font: 600 17px var(--pmono); }
.ph-health-stat small { text-transform: none; }
.ph-health-drill { display: grid; gap: 4px; margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--pborder-soft); }
.ph-health-drill > b { color: var(--ptext2); font-size: 11px; }
.ph-health-drill button { display: flex; justify-content: space-between; gap: 12px; border: 0; background: transparent; color: var(--ptext2); padding: 4px 2px; text-align: left; cursor: pointer; }
.ph-health-drill button:hover { color: var(--pacc); }
.ph-health-drill small { color: var(--ptext3); font-family: var(--pmono); }

/* shared data projections */
.ph-data-view { min-width: 0; }
.ph-view-meta { color: var(--ptext3); font-family: var(--pmono); font-size: 11px; margin-bottom: 10px; }
.ph-view-meta b { color: var(--ptext); }
.ph-view-tools { display: flex; align-items: center; gap: 7px; margin-bottom: 14px; }
.ph-table-wrap { max-height: calc(100vh - 180px); overflow: auto; border: 1px solid var(--pborder); border-radius: 10px; background: var(--psurface); }
.ph-table { width: 100%; border-collapse: separate; border-spacing: 0; min-width: 900px; font-size: 12px; }
.ph-table th { position: sticky; top: 0; z-index: 2; text-align: left; background: var(--psurface2); color: var(--ptext2); font: 600 10px var(--pmono); letter-spacing: .06em; text-transform: uppercase; }
.ph-table th, .ph-table td { padding: 8px 10px; border-right: 1px solid var(--pborder-soft); border-bottom: 1px solid var(--pborder-soft); }
.ph-table tr.selected td { background: var(--pacc-soft); }
.ph-table select, .ph-table input { max-width: 130px; border: 1px solid transparent; background: transparent; color: var(--ptext); padding: 4px; border-radius: 4px; }
.ph-table select:focus, .ph-table input:focus { border-color: var(--pacc-line); outline: none; background: var(--psurface2); }
.ph-link { border: 0; background: none; color: var(--ptext); font-weight: 600; text-align: left; cursor: pointer; }
.ph-link:hover { color: var(--pacc); }

.ph-gantt { position: relative; min-width: 760px; border: 1px solid var(--pborder); border-radius: 10px; overflow: hidden; background: repeating-linear-gradient(90deg, transparent 0, transparent calc(10% - 1px), var(--pborder-soft) 10%); }
.ph-gantt-row { display: grid; grid-template-columns: 280px 1fr; min-height: 52px; border-bottom: 1px solid var(--pborder-soft); }
.ph-gantt-label-wrap { position: relative; z-index: 2; border-right: 1px solid var(--pborder); background: var(--psurface); padding: 5px 8px; overflow: hidden; }
.ph-gantt-label { width: 100%; text-align: left; border: 0; background: transparent; color: var(--ptext); padding: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.ph-gantt-dates { display: flex; gap: 5px; margin-top: 4px; }
.ph-gantt-dates input { min-width: 0; width: 118px; border: 1px solid var(--pborder-soft); border-radius: 4px; background: var(--psurface2); color: var(--ptext2); font-size: 10px; }
.ph-gantt-track { position: relative; }
.ph-gantt-bar { position: absolute; top: 9px; height: 20px; min-width: 6px; border: 1px solid var(--pacc-line); border-radius: 5px; background: var(--pacc); cursor: pointer; }
.ph-milestone { position: absolute; right: -8px; top: -1px; color: var(--ptext); }
.ph-today-line { position: absolute; z-index: 3; top: 0; bottom: 0; width: 1px; background: var(--pred); pointer-events: none; }
.ph-today-line span { position: absolute; top: 2px; left: 3px; color: var(--pred); font: 9px var(--pmono); }
.ph-unscheduled { margin-top: 16px; border: 1px dashed var(--pborder); border-radius: 9px; padding: 10px; }
.ph-unscheduled h3 { margin: 0 0 8px; font-size: 12px; color: var(--ptext2); }
.ph-unscheduled h3 span { color: var(--ptext3); }
.ph-unscheduled button { margin: 3px; border: 1px solid var(--pborder); border-radius: 6px; background: var(--psurface); color: var(--ptext2); padding: 5px 8px; cursor: pointer; }

.ph-calendar { display: grid; grid-template-columns: repeat(7, minmax(100px, 1fr)); border: 1px solid var(--pborder); border-radius: 10px; overflow: auto; background: var(--psurface); }
.ph-calendar-head { padding: 7px; border-right: 1px solid var(--pborder-soft); background: var(--psurface2); color: var(--ptext2); text-align: center; font: 10px var(--pmono); text-transform: uppercase; }
.ph-day { min-height: 110px; padding: 6px; border-right: 1px solid var(--pborder-soft); border-top: 1px solid var(--pborder-soft); color: var(--ptext2); }
.ph-day.muted { background: color-mix(in srgb, var(--psurface2) 45%, transparent); color: var(--ptext3); }
.ph-day.today { box-shadow: inset 0 0 0 2px var(--pacc); }
.ph-day > span { display: block; margin-bottom: 4px; font: 10px var(--pmono); }
.ph-day button { width: 100%; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 3px 0; padding: 4px 5px; border: 1px solid var(--pacc-line); border-radius: 5px; background: var(--pacc-soft); color: var(--ptext); text-align: left; font-size: 10px; cursor: grab; }

@media (max-width: 1100px) {
  .ph-side { width: 210px; }
  .ph-top { padding-inline: 16px; }
  .ph-search, .ph-view-presets { display: none; }
  .ph-canvas { padding-inline: 16px; }
}

/* activity */
.ph-activity-lead { margin-bottom: 18px; }
.ph-timeline { display: flex; flex-direction: column; position: relative; }
.ph-timeline::before { content: ''; position: absolute; top: 7px; bottom: 7px; left: 6px; width: 1px; background: var(--pborder); }
.ph-activity { display: grid; grid-template-columns: 13px minmax(0, 1fr) auto; gap: 14px; width: 100%; text-align: left; background: transparent; border: none; color: inherit; padding: 0 0 18px; cursor: pointer; }
.ph-activity:hover .ph-activity-task { color: var(--pacc); }
.ph-activity-dot { width: 13px; height: 13px; border-radius: 50%; margin-top: 5px; background: var(--ptext3); border: 3px solid var(--pbg); position: relative; z-index: 1; }
.ph-activity-dot.heartbeat { background: var(--pacc); box-shadow: 0 0 0 3px var(--pacc-soft); }
.ph-activity-dot.sulla { background: var(--ptext2); }
.ph-activity-dot.human { background: var(--pgreen); }
.ph-activity-dot.workbench { background: var(--pamber); }
.ph-activity-dot.event { background: var(--pbg); border-color: var(--ptext3); }
.ph-activity-kind { display: inline-block; padding: 1px 6px; border-radius: 4px; background: var(--psurf2); color: var(--ptext2); border: 1px solid var(--pborder); font-weight: 600; letter-spacing: 0.05em; }
.ph-activity-kind.k-comment { background: var(--pacc-soft); color: var(--pacc); border-color: transparent; }
.ph-activity-kind.k-task_created, .ph-activity-kind.k-epic_created, .ph-activity-kind.k-project_created { color: var(--pgreen); }
.ph-activity.is-event .ph-activity-text { color: var(--ptext3); font-style: italic; }
.ph-activity-body { min-width: 0; display: flex; flex-direction: column; gap: 5px; padding-bottom: 2px; }
.ph-activity-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-family: var(--pmono); font-size: 10.5px; color: var(--ptext3); text-transform: uppercase; letter-spacing: 0.06em; }
.ph-activity-actor { display: inline-flex; align-items: center; min-height: 18px; padding: 1px 7px; border-radius: 4px; border: 1px solid var(--pborder); background: var(--psurf2); color: var(--ptext2); font-weight: 700; }
.ph-activity-actor.heartbeat { color: var(--pacc); background: var(--pacc-soft); border-color: var(--pacc-line); }
.ph-activity-actor.sulla { color: var(--ptext); }
.ph-activity-actor.human { color: var(--pgreen); border-color: color-mix(in srgb, var(--pgreen) 45%, transparent); }
.ph-activity-actor.workbench { color: var(--pamber); border-color: color-mix(in srgb, var(--pamber) 45%, transparent); }
.ph-activity-task { display: block; color: var(--ptext); font-size: 14px; font-weight: 600; line-height: 1.4; transition: color 0.12s ease; }
.ph-activity-text { display: -webkit-box; max-width: 780px; overflow: hidden; color: var(--ptext2); font-size: 13px; line-height: 1.55; white-space: pre-wrap; -webkit-line-clamp: 4; -webkit-box-orient: vertical; }

/* projects overview */
.ph-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.ph-pcard { border: 1px solid var(--pborder); border-radius: 13px; padding: 20px 22px; background: var(--psurface); cursor: pointer; }
.ph-pcard:hover { border-color: var(--pacc-line); }
.ph-lane { display: inline-block; font-family: var(--pmono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; padding: 3px 9px; border-radius: 5px; border: 1px solid var(--pborder); color: var(--ptext2); margin-bottom: 12px; }
.ph-lane.hb { color: var(--pacc); border-color: var(--pacc-line); background: var(--pacc-soft); }
.ph-pcard h3 { font-family: var(--pserif); font-weight: 500; font-size: 21px; margin: 0 0 10px; color: var(--ptext); }
.ph-pcard p { font-size: 13px; color: var(--ptext2); line-height: 1.6; margin: 0 0 18px; }
.ph-prog { height: 6px; border-radius: 4px; background: var(--psurface2); overflow: hidden; margin-bottom: 12px; }
.ph-prog > i { display: block; height: 100%; background: var(--pacc); }
.ph-prog.amber > i { background: var(--pamber); }
.ph-prog.gray > i { background: var(--ptext3); }
.ph-nums { display: flex; gap: 22px; font-size: 13px; color: var(--ptext3); }
.ph-nums b { color: var(--ptext); font-weight: 600; font-family: var(--pmono); }

/* forms */
.ph-fl { display: block; font-family: var(--pmono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ptext3); margin: 12px 0 5px; }
.ph-in { width: 100%; background: var(--psurface2); border: 1px solid var(--pborder); border-radius: 7px; color: var(--ptext); font-family: var(--psans); font-size: 13px; padding: 8px 10px; }
.ph-in:focus { outline: none; border-color: var(--pacc-line); }
.ph-ta { resize: vertical; line-height: 1.5; }
.ph-frow { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

/* drawer */
.ph-scrim { position: absolute; inset: 0; background: rgba(4, 7, 12, 0.55); z-index: 20; }
.ph-scrim.center { display: flex; align-items: center; justify-content: center; }
.ph-drawer { position: absolute; top: 0; right: 0; bottom: 0; width: 380px; background: var(--psurface); border-left: 1px solid var(--pborder); z-index: 21; display: flex; flex-direction: column; box-shadow: -20px 0 50px rgba(0, 0, 0, 0.4); }
.ph-dependencies { display: grid; gap: 6px; margin-bottom: 8px; }
.ph-dependency { display: flex; align-items: center; justify-content: space-between; gap: 8px; border: 1px solid var(--pborder); border-radius: 7px; background: var(--psurface2); color: var(--ptext2); padding: 7px 8px; font-size: 11px; }
.ph-dh { display: flex; align-items: center; padding: 16px 18px 12px; border-bottom: 1px solid var(--pborder-soft); }
.ph-dh-id { font-family: var(--pmono); font-size: 10px; letter-spacing: 0.12em; color: var(--ptext3); flex: 1; }
.ph-x { background: transparent; border: none; color: var(--ptext3); font-size: 15px; cursor: pointer; }
.ph-x:hover { color: var(--ptext); }
.ph-db { flex: 1; overflow: auto; padding: 6px 18px 22px; }
.ph-dactions { display: flex; gap: 8px; margin-top: 18px; }
.ph-cmt-h { font-family: var(--pmono); font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ptext3); margin: 22px 0 10px; border-top: 1px solid var(--pborder-soft); padding-top: 16px; }
.ph-cmt-h span { color: var(--ptext2); }
.ph-cmt { border-left: 2px solid var(--pacc-line); padding: 4px 0 4px 10px; margin-bottom: 10px; }
.ph-cmt-who { font-family: var(--pmono); font-size: 10px; color: var(--pacc); margin-bottom: 3px; }
.ph-cmt-b { font-size: 12.5px; color: var(--ptext2); line-height: 1.5; white-space: pre-wrap; }
.ph-receipt-evidence { max-height: 280px; overflow: auto; margin: 8px 0 0; padding: 9px; border: 1px solid var(--pborder); border-radius: 6px; background: var(--pbg); color: var(--ptext2); font: 10px/1.45 var(--pmono); white-space: pre-wrap; }
.ph-cmt-add { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
.ph-cmt-add .ph-btn { align-self: flex-end; }

/* modal */
.ph-modal { width: 460px; max-width: calc(100% - 40px); max-height: calc(100% - 60px); overflow: auto; background: var(--psurface); border: 1px solid var(--pborder); border-radius: 14px; padding: 22px 24px 24px; box-shadow: 0 30px 80px rgba(0, 0, 0, 0.5); }
.ph-modal h2 { font-family: var(--pserif); font-weight: 500; font-size: 22px; margin: 0 0 6px; color: var(--ptext); }
</style>
