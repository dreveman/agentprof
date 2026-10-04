// SPDX-License-Identifier: Apache-2.0
import m from 'mithril';
import type {App} from '../../public/app';
import {Button} from '../../widgets/button';
import {HotkeyGlyphs} from '../../widgets/hotkey_glyphs';
import {AgentprofBrand} from './agentprof_brand';
import './agentprof_home_page.scss';

export class AgentprofHomePage implements m.ClassComponent<{app: App}> {
  private agent: 'pi' | 'claude' = 'pi';

  view({attrs: {app}}: m.CVnode<{app: App}>) {
    const isPi = this.agent === 'pi';
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
        m(
          '.ap-home__agents',
          {role: 'group', 'aria-label': 'Recording agent'},
          m('span.ap-home__agent-label', 'Agent'),
          (['pi', 'claude'] as const).map((agent) =>
            m(Button, {
              label: agent === 'pi' ? 'Pi' : 'Claude Code',
              active: this.agent === agent,
              'aria-pressed': String(this.agent === agent),
              onclick: () => {
                this.agent = agent;
              },
            }),
          ),
        ),
        step(
          '1',
          'Install agent tracing',
          isPi
            ? 'Install the tracing extension for your Pi account:'
            : 'Install the Claude Code recorder with Git and npm. Requires a signed-in Claude Code CLI.',
          isPi
            ? command('pi install git:github.com/dreveman/agentprof')
            : m(
                '.ap-home__commands',
                command(
                  'git clone https://github.com/dreveman/agentprof.git ~/agentprof',
                ),
                command('npm ci --prefix ~/agentprof'),
              ),
        ),
        step(
          '2',
          'Record your agent',
          isPi
            ? 'Start Pi with tracing enabled and run your task as usual.'
            : 'From your project directory, run a task in Claude Code’s print mode. This integration is a preview.',
          isPi
            ? [
                command('pi --tracing'),
                m(
                  'p.ap-home__record-note',
                  'Exit Pi to save the recording and print its file path. Optionally, press ',
                  m(HotkeyGlyphs, {hotkey: 'Ctrl+Shift+T'}),
                  ' in Pi to manually start or stop recording.',
                ),
              ]
            : [
                command(
                  [
                    '~/agentprof/node_modules/.bin/bun \\',
                    '  ~/agentprof/tools/record-claude.ts \\',
                    '  agent.pftrace -- -p -- "Your task"',
                  ].join('\n'),
                ),
                m(
                  'p.ap-home__record-note',
                  'Saves ',
                  m('code', 'agent.pftrace'),
                  ' on exit and prints its path. Use a new file name for each run. ',
                  m(
                    'a',
                    {
                      href: 'https://github.com/dreveman/agentprof/blob/main/packages/claude-tracing/README.md',
                      target: '_blank',
                      rel: 'noopener',
                    },
                    'Claude Code recording guide',
                  ),
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
          type: 'button', onclick: () => app.commands.runCommand('dev.agentprof.Agentprof.OpenComparisonExample'),
        },
          m('span.ap-home__example-title', 'Open Pi vs Claude Code example'),
          m('span', 'Coding task run with Pi codemode and Claude Code using the same prompt and model.'),
          m('span.ap-home__example-meta', 'Pi and Claude Code · Anthropic Haiku 4.5 · Thinking off · 2 sessions'),
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
