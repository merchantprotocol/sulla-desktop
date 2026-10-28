<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<!--
  Sulla Desktop · https://sulladesktop.com
  Portions Copyright SUSE LLC and the Rancher Desktop contributors, licensed under
  the Apache License 2.0 (LICENSES/Apache-2.0.txt).
  Modifications Copyright (c) 2025-2026 Merchant Protocol LLC, licensed under the
  GPL-2.0-or-later (LICENSE).
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<script>
export default {
  props: {
    value: {
      type:    [String, Object],
      default: null,
    },

    status: {
      type:    String,
      default: 'error',
    },

    hover: {
      type:    Boolean,
      default: true,
    },
  },
};
</script>

<template>
  <div
    ref="container"
    class="labeled-tooltip"
    :class="{ [status]: true, hoverable: hover }"
  >
    <template v-if="hover">
      <i
        v-tooltip="value.content ? { ...{ content: value.content, classes: [`tooltip-${status}`] }, ...value } : value"
        :class="{ hover: !value }"
        class="icon icon-info-circle status-icon"
      />
    </template>
    <template v-else>
      <i
        :class="{ hover: !value }"
        class="icon icon-info-circle status-icon"
      />
      <div
        v-if="value"
        class="tooltip"
        x-placement="bottom"
      >
        <div class="tooltip-arrow" />
        <div class="tooltip-inner">
          {{ value }}
        </div>
      </div>
    </template>
  </div>
</template>

<style lang='scss'>
.labeled-tooltip {
    position: absolute;
    width: 100%;
    height: 100%;
    left: 0;
    top: 0;

    &.hoverable {
      height: 0%;
    }

     .status-icon {
         position:  absolute;
         right: 30px;
         top: $input-padding-lg;
         font-size: var(--fs-heading);
         z-index: z-index(hoverOverContent);

     }

    .tooltip {
        position: absolute;
        width: calc(100% + 2px);
        top: calc(100% + 6px);

        .tooltip-arrow {
            right: 30px;
        }

        .tooltip-inner {
            padding: 10px;
        }
    }

    @mixin tooltipColors($color, $borderColor) {
        .status-icon {
            color: $color;
        }
        .tooltip {
            .tooltip-inner {
                color: var(--input-bg);
                background: $color;
                border-color: $borderColor;
            }

            .tooltip-arrow {
                border-bottom-color: $borderColor;
                &:after {
                    border: none;
                }
            }
        }
    }

    &.error {
        @include tooltipColors(var(--error), var(--border-error));
    }

    &.warning {
        @include tooltipColors(var(--warning), var(--border-warning));
    }

    &.success {
        @include tooltipColors(var(--success), var(--border-success));
    }
}
</style>
