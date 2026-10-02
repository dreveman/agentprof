// SPDX-License-Identifier: Apache-2.0
import m from 'mithril';
import type {App} from '../../public/app';
import {HotkeyGlyphs} from '../../widgets/hotkey_glyphs';
import {AgentprofBrand} from './agentprof_brand';
import './agentprof_home_page.scss';

export class AgentprofHomePage implements m.ClassComponent<{app: App}> {
  view({attrs: {app}}: m.CVnode<{app: App}>) {
    const command = (text: string) =>
      m(
        '.ap-home__command',
        m('span', {'aria-hidden': 'true'}, '$'),
        m('code', text),
      );
    const step = (
      number: string,
      title: string,
      description: m.Children,
      content: m.Children,
    ) =>
      m(
        'article.ap-home__step',
        m('span.ap-home__number', {'aria-hidden': 'true'}, number),
        m('h2', title),
        m('p', description),
        m('.ap-home__step-content', content),
      );
    return m(
      'main.ap-home',
      m(
        'header.ap-home__hero',
        m(AgentprofBrand, {className: 'ap-home__logo'}),
        m('h1', 'See where your agent spends its time.'),
        m(
          'p.ap-home__lede',
          'Explore model responses, tool calls, and token usage. Open sessions together to compare runs and follow delegated work.',
        ),
      ),
      m(
        'section.ap-home__steps',
        {'aria-label': 'Get started'},
        step(
          '1',
          'Install agent tracing',
          'Pi is currently supported. Install the tracing extension for your user account:',
          m(
            '.ap-home__install',
            m('span.ap-home__harness', 'Pi'),
            command('pi install git:github.com/dreveman/agentprof'),
          ),
        ),
        step(
          '2',
          'Record your agent',
          'Start Pi with tracing enabled and run your task as usual.',
          [
            command('pi --tracing'),
            m(
              'p.ap-home__record-note',
              'Exit Pi to save the recording and print its file path. Optionally, press ',
              m(HotkeyGlyphs, {hotkey: 'Ctrl+Shift+T'}),
              ' in Pi to manually start or stop recording.',
            ),
          ],
        ),
        step(
          '3',
          'Open existing agent recordings',
          'Choose a .pftrace file or a trace archive. Select multiple files to view sessions together.',
          m(
            'button.ap-home__open',
            {
              type: 'button',
              onclick: () => app.commands.runCommand('dev.perfetto.OpenTrace'),
            },
            'Open recordings',
          ),
        ),
      ),
      m(
        'section.ap-home__examples',
        m('h2', 'Or explore an example'),
        m(
          'button.ap-home__example',
          {
            type: 'button',
            onclick: () =>
              app.commands.runCommand('dev.agentprof.Agentprof.OpenExample'),
          },
          m('span.ap-home__example-title', 'Open workflow example'),
          m(
            'span',
            'Coding task with a primary agent, parallel implementation and test workers, and a reviewer.',
          ),
          m(
            'span.ap-home__example-meta',
            'Pi · Anthropic Opus 5 · High effort · 4 sessions',
          ),
        ),
        m('button.ap-home__example', {
          type: 'button', onclick: () => app.commands.runCommand('dev.agentprof.Agentprof.OpenCodemodeExample'),
        },
          m('span.ap-home__example-title', 'Open direct vs codemode example'),
          m('span', 'Auditing task for 192 synthetic CI failures, run twice to compare direct tool calls with scripted tool calls in codemode.'),
          m('span.ap-home__example-meta', 'Pi · Anthropic Opus 5 · High effort · 2 sessions'),
        ),
      ),
      m(
        'aside.ap-home__shortcuts',
        {'aria-label': 'Keyboard shortcuts'},
        m('strong', 'Shortcuts'),
        m('span', 'Open recordings ', m(HotkeyGlyphs, {hotkey: '!Mod+O'})),
        m('span', 'Commands ', m(HotkeyGlyphs, {hotkey: '!Mod+Shift+P'})),
      ),
      m(
        'p.ap-home__privacy',
        'Open local recordings directly in the browser. No upload is required.',
      ),
      m(
        'footer.ap-home__footer',
        m(
          'a',
          {
            href: 'https://github.com/dreveman/agentprof',
            target: '_blank',
            rel: 'noopener',
          },
          'Agent Profiler',
        ),
        m('span', '·'),
        m(
          'a',
          {href: 'https://perfetto.dev', target: '_blank', rel: 'noopener'},
          'Built on Perfetto',
        ),
      ),
    );
  }
}
