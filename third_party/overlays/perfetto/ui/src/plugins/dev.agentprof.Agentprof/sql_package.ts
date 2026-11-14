// SPDX-License-Identifier: Apache-2.0
import type {SqlPackage} from '../../public/extra_sql_packages';
import activitySql from '../../../../../../../stdlib/dev/agentprof/activity.sql?raw';
import capturesSql from '../../../../../../../stdlib/dev/agentprof/captures.sql?raw';
import contextSql from '../../../../../../../stdlib/dev/agentprof/context.sql?raw';
import modelsSql from '../../../../../../../stdlib/dev/agentprof/models.sql?raw';
import runtimeSql from '../../../../../../../stdlib/dev/agentprof/runtime.sql?raw';
import sessionsSql from '../../../../../../../stdlib/dev/agentprof/sessions.sql?raw';
import toolsSql from '../../../../../../../stdlib/dev/agentprof/tools.sql?raw';
import turnsSql from '../../../../../../../stdlib/dev/agentprof/turns.sql?raw';

export const AGENTPROF_SQL_PACKAGE: SqlPackage = {
  name: 'dev.agentprof',
  modules: [
    {name: 'dev.agentprof.activity', sql: activitySql},
    {name: 'dev.agentprof.captures', sql: capturesSql},
    {name: 'dev.agentprof.context', sql: contextSql},
    {name: 'dev.agentprof.models', sql: modelsSql},
    {name: 'dev.agentprof.runtime', sql: runtimeSql},
    {name: 'dev.agentprof.sessions', sql: sessionsSql},
    {name: 'dev.agentprof.tools', sql: toolsSql},
    {name: 'dev.agentprof.turns', sql: turnsSql},
  ],
};
