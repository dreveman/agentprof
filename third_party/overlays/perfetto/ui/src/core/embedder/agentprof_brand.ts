// SPDX-License-Identifier: Apache-2.0
import m from 'mithril';
import './agentprof_brand.scss';
import {AGENTPROF_WORDMARK} from './agentprof_wordmark';
import {AGENTPROF_ICON_SVG} from './agentprof_icon';

const logo = `<svg xmlns="http://www.w3.org/2000/svg" width="174" height="36" viewBox="0 0 174 36">
  ${AGENTPROF_ICON_SVG.replace('<svg ', '<svg x="0" y="3" width="30" height="30" ')}
  ${AGENTPROF_WORDMARK.replace('fill="white"', 'fill="currentColor"').replace('<svg ', '<svg x="34" ')}
</svg>`;
export const AGENTPROF_BRAND = {
  src: `data:image/svg+xml,${encodeURIComponent(logo)}`,
  alt: 'Agent Profiler',
};

export class AgentprofBrand implements m.ClassComponent<{className?: string}> {
  view({attrs}: m.CVnode<{className?: string}>) {
    return m(
      'span.ap-brand',
      {
        'className': attrs.className,
        'role': 'img',
        'aria-label': 'Agent Profiler',
      },
      m.trust(logo),
    );
  }
}
