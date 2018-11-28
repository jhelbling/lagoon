// @flow

const R = require('ramda');
const sqlClient = require('../../clients/sqlClient');
const {
  knex,
  ifNotAdmin,
  inClauseOr,
  prepare,
  query,
  isPatchEmpty,
} = require('../../util/db');
const Sql = require('./sql');
const Helpers = require('./helpers');
const environmentHelpers = require('../environment/helpers');
const envValidators = require('../environment/validators');

/* ::

import type {ResolversObj} from '../';

*/

const taskStatusTypeToString = R.cond([
  [R.equals('ACTIVE'), R.toLower],
  [R.equals('SUCCEEDED'), R.toLower],
  [R.equals('FAILED'), R.toLower],
  [R.T, R.identity],
]);

const getTasksByEnvironmentId = async (
  { id: eid },
  args,
  {
    credentials: {
      role,
      permissions: { customers, projects },
    },
  },
) => {
  const prep = prepare(
    sqlClient,
    `SELECT
        t.*
      FROM environment e
      JOIN task t on e.id = t.environment
      JOIN project p ON e.project = p.id
      WHERE e.id = :eid
      ${ifNotAdmin(
    role,
    `AND (${inClauseOr([['p.customer', customers], ['p.id', projects]])})`,
  )}
    `,
  );

  const rows = await query(sqlClient, prep({ eid }));

  return rows.map(row => Helpers.injectLogs(row));
};

const getTaskByRemoteId = async (
  root,
  { id },
  {
    credentials: {
      role,
      permissions: { customers, projects },
    },
  },
) => {
  const queryString = knex('task')
    .where('remote_id', '=', id)
    .toString();

  const rows = await query(sqlClient, queryString);
  const task = R.prop(0, rows);

  if (!task) {
    return null;
  }

  if (role !== 'admin') {
    const rowsPerms = await query(sqlClient, Sql.selectPermsForTask(task.id));

    if (
      !R.contains(R.path(['0', 'pid'], rowsPerms), projects) &&
      !R.contains(R.path(['0', 'cid'], rowsPerms), customers)
    ) {
      throw new Error('Unauthorized.');
    }
  }

  return Helpers.injectLogs(task);
};

const addTask = async (
  root,
  {
    input: {
      id,
      name,
      status: unformattedStatus,
      created,
      started,
      completed,
      environment,
      service,
      command,
      remoteId,
      execute: executeRequest,
    },
  },
  {
    credentials,
    credentials: {
      role,
    },
  },
) => {
  const status = taskStatusTypeToString(unformattedStatus);
  const execute = role === 'admin' ? executeRequest : true;

  await envValidators.environmentExists(environment);
  await envValidators.userAccessEnvironment(credentials, environment);

  const taskData = await Helpers.addTask({
    id,
    name,
    status,
    created,
    started,
    completed,
    environment,
    service,
    command,
    remoteId,
    execute,
  });

  return Helpers.injectLogs(taskData);
};

const deleteTask = async (
  root,
  { input: { id } },
  {
    credentials: {
      role,
      permissions: { customers, projects },
    },
  },
) => {
  if (role !== 'admin') {
    const rows = await query(sqlClient, Sql.selectPermsForTask(id));

    if (
      !R.contains(R.path(['0', 'pid'], rows), projects) &&
      !R.contains(R.path(['0', 'cid'], rows), customers)
    ) {
      throw new Error('Unauthorized.');
    }
  }

  await query(sqlClient, Sql.deleteTask(id));

  return 'success';
};

const updateTask = async (
  root,
  {
    input: {
      id,
      patch,
      patch: {
        name,
        status: unformattedStatus,
        created,
        started,
        completed,
        environment,
        service,
        command,
        remoteId,
      },
    },
  },
  {
    credentials,
    credentials: {
      role,
      permissions: { customers, projects },
    },
  },
) => {
  const status = taskStatusTypeToString(unformattedStatus);

  // Check access to modify task as it currently stands
  if (role !== 'admin') {
    const rowsCurrent = await query(sqlClient, Sql.selectPermsForTask(id));

    if (
      !R.contains(R.path(['0', 'pid'], rowsCurrent), projects) &&
      !R.contains(R.path(['0', 'cid'], rowsCurrent), customers)
    ) {
      throw new Error('Unauthorized.');
    }
  }

  // Check access to modify task as it will be updated
  await envValidators.userAccessEnvironment(credentials, environment);

  if (isPatchEmpty({ patch })) {
    throw new Error('Input patch requires at least 1 attribute');
  }

  await query(
    sqlClient,
    Sql.updateTask({
      id,
      patch: {
        name,
        status,
        created,
        started,
        completed,
        environment,
        service,
        command,
        remoteId,
      },
    }),
  );

  const rows = await query(sqlClient, Sql.selectTask(id));

  return Helpers.injectLogs(R.prop(0, rows));
};

const taskDrushArchiveDump = async (
  root,
  {
    environment,
  },
  {
    credentials,
  },
) => {
  await envValidators.environmentExists(environment);
  await envValidators.userAccessEnvironment(credentials, environment);
  await envValidators.environmentHasService(environment, 'cli');

  const taskData = await Helpers.addTask({
    name: 'Drush archive-dump',
    environment,
    service: 'cli',
    command: 'drush archive-dump',
    execute: true,
  });

  return Helpers.injectLogs(taskData);
};

const taskDrushSqlSync = async (
  root,
  {
    sourceEnvironment: sourceEnvironmentId,
    destinationEnvironment: destinationEnvironmentId,
  },
  {
    credentials,
  },
) => {
  await envValidators.environmentExists(sourceEnvironmentId);
  await envValidators.environmentExists(destinationEnvironmentId);
  await envValidators.environmentsHaveSameProject([sourceEnvironmentId, destinationEnvironmentId]);
  await envValidators.userAccessEnvironment(credentials, sourceEnvironmentId);
  await envValidators.userAccessEnvironment(credentials, destinationEnvironmentId);
  await envValidators.environmentHasService(sourceEnvironmentId, 'cli');

  const sourceEnvironment = await environmentHelpers.getEnvironmentById(sourceEnvironmentId);
  const destinationEnvironment = await environmentHelpers.getEnvironmentById(destinationEnvironmentId);

  const taskData = await Helpers.addTask({
    name: `Sync DB ${sourceEnvironment.name} -> ${destinationEnvironment.name}`,
    environment: destinationEnvironmentId,
    service: 'cli',
    command: `drush sql-sync @${sourceEnvironment.name} @${destinationEnvironment.name}`,
    execute: true,
  });

  return Helpers.injectLogs(taskData);
};

const taskDrushRsyncFiles = async (
  root,
  {
    sourceEnvironment: sourceEnvironmentId,
    destinationEnvironment: destinationEnvironmentId,
  },
  {
    credentials,
  },
) => {
  await envValidators.environmentExists(sourceEnvironmentId);
  await envValidators.environmentExists(destinationEnvironmentId);
  await envValidators.environmentsHaveSameProject([sourceEnvironmentId, destinationEnvironmentId]);
  await envValidators.userAccessEnvironment(credentials, sourceEnvironmentId);
  await envValidators.userAccessEnvironment(credentials, destinationEnvironmentId);
  await envValidators.environmentHasService(sourceEnvironmentId, 'cli');

  const sourceEnvironment = await environmentHelpers.getEnvironmentById(sourceEnvironmentId);
  const destinationEnvironment = await environmentHelpers.getEnvironmentById(destinationEnvironmentId);

  const taskData = await Helpers.addTask({
    name: `Sync files ${sourceEnvironment.name} -> ${destinationEnvironment.name}`,
    environment: destinationEnvironmentId,
    service: 'cli',
    command: `drush rsync @${sourceEnvironment.name}:%files @${destinationEnvironment.name}:%files`,
    execute: true,
  });

  return Helpers.injectLogs(taskData);
};

const Resolvers /* : ResolversObj */ = {
  getTasksByEnvironmentId,
  getTaskByRemoteId,
  addTask,
  deleteTask,
  updateTask,
  taskDrushArchiveDump,
  taskDrushSqlSync,
  taskDrushRsyncFiles,
};

module.exports = Resolvers;
