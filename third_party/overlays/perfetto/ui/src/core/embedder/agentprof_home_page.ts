// SPDX-License-Identifier: Apache-2.0
import m from 'mithril';
import type {App} from '../../public/app';
import {Button} from '../../widgets/button';
import {HotkeyGlyphs} from '../../widgets/hotkey_glyphs';
import {AgentprofBrand} from './agentprof_brand';
import {exampleForAgent, type RecordingAgent} from '../../plugins/dev.agentprof.Agentprof/examples';
import './agentprof_home_page.scss';

export class AgentprofHomePage implements m.ClassComponent<{app: App}> {
  private agent: RecordingAgent = 'claude';

  view({attrs: {app}}: m.CVnode<{app: App}>) {
    const isPi = this.agent === 'pi';
    const isCodex = this.agent === 'codex';
    const isMuse = this.agent === 'muse';
    const recorder = isMuse ? 'muse' : isCodex ? 'codex' : 'claude';
    const agentName = isMuse ? 'Muse Code' : isCodex ? 'Codex' : 'Claude Code';
    const example = exampleForAgent(this.agent);
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
          (['claude', 'codex', 'muse', 'pi'] as const).map((agent) =>
            m(Button, {
              label: agent === 'pi' ? 'Pi' : agent === 'codex' ? 'Codex' : agent === 'muse' ? 'Muse Code' : 'Claude Code',
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
            : isMuse
              ? 'Install the Muse Code plugin. Requires Muse Code 1.4.1 or later with plugins enabled, and Node.js 22 or later.'
              : isCodex
              ? 'Install the native Codex plugin. Requires Codex CLI 0.160.0 or later, and Node.js 22 or later.'
              : 'Install the Claude Code plugin. Requires Claude Code 2.1.289 or later with mods enabled, and Node.js 22 or later.',
          isPi
            ? command('pi install git:github.com/dreveman/agentprof')
            : !isCodex && !isMuse
              ? m('.ap-home__commands',
                  command('claude plugin marketplace add dreveman/agentprof'),
                  command('claude plugin install agentprof@agentprof'),
                )
              : isCodex
              ? m('.ap-home__commands',
                  command('codex plugin marketplace add dreveman/agentprof'),
                  command('codex plugin add agentprof@agentprof'),
                )
              : m(
                '.ap-home__commands',
                command('npm install -g github:dreveman/agentprof'),
                command(`agentprof-${recorder} install`),
                isMuse ? command('muse plugins approve agentprof') : undefined,
              ),
        ),
        step(
          '2',
          'Record your agent',
          isPi
            ? 'Start Pi with tracing enabled and run your task as usual.'
            : isMuse
              ? 'Start Muse normally, type tracing start, then run your task.'
              : isCodex
              ? 'Start Codex normally. Review the plugin hooks in /hooks, then type tracing start.'
              : 'Start Claude normally. Use the recording button or /tracing start, then run your task.',
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
            : !isCodex && !isMuse
              ? [
                  command('claude'),
                  m('p.ap-home__record-note',
                    'Press ', m(HotkeyGlyphs, {hotkey: 'Ctrl+X'}),
                    ', then Tab and R to start or stop recording. ',
                    'Use /tracing stop to save, or exit Claude to finish the recording. ',
                    'The agent can also use tracing_start and tracing_stop tools.',
                    ' ',
                    m('a', {
                      href: 'https://github.com/dreveman/agentprof/blob/main/packages/claude-tracing/README.md',
                      target: '_blank', rel: 'noopener',
                    }, 'Claude Code recording guide'),
                  ),
                ]
              : [
                command(isMuse ? 'muse' : 'codex'),
                m(
                  'p.ap-home__record-note',
                  `Type tracing stop to save, or exit ${isMuse ? 'Muse' : 'Codex'} to finish the recording. `,
                  'Use tracing status to see its path. The agent can also use tracing_start and tracing_stop tools. ',
                  m(
                    'a',
                    {
                      href: `https://github.com/dreveman/agentprof/blob/main/packages/${recorder}-tracing/README.md`,
                      target: '_blank',
                      rel: 'noopener',
                    },
                    `${agentName} recording guide`,
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
            onclick: () => app.commands.runCommand(example.commandId),
          },
          m('span.ap-home__example-title', example.title),
          m('span', example.description),
          m('span.ap-home__example-meta', example.metadata),
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
