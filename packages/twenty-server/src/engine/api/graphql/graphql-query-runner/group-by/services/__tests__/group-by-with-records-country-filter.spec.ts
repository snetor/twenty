import { GroupByWithRecordsService } from 'src/engine/api/graphql/graphql-query-runner/group-by/services/group-by-with-records.service';

// ─────────────────────────────────────────────────────────────────────────────
// SPEC-SENTINELLE. Elle garde l'ORDRE, pas la forme du prédicat.
//
// 🔴 L'incident d'origine : la sous-requête du groupBy est sérialisée en SQL brut par
// `getQuery()`. Si les prédicats de permission sont posés APRÈS cette sérialisation,
// le SQL est figé sans eux — et Kanban comme Calendrier remontent des enregistrements
// hors périmètre, sans qu'aucune erreur ne se produise.
//
// Ce que la montée v2.39.0 a changé : jusqu'à la v2.34.0 le fork devait rappeler
// lui-même son prédicat ici, par un patch d'une ligne au milieu d'une méthode privée.
// Depuis, `subQueryBuilder.applyRowLevelPermissions()` déclenche le hook
// `onBeforeExecute` du `WorkspaceRepository`, où le cloisonnement Snetor est branché —
// voir `twenty-orm/repository/__tests__/workspace-repository-country-filter.spec.ts`.
// Il n'y a donc PLUS de patch Snetor dans ce fichier, et c'est voulu.
//
// Cette spec reste parce que l'invariant, lui, reste : si un jour l'amont déplace
// `applyRowLevelPermissions()` après `getQuery()`, ou le retire, le cloisonnement du
// groupBy tombe en silence. Ne pas la supprimer au motif qu'elle ne défend plus de
// code Snetor — c'est précisément ce qu'elle défend : une dépendance invisible.
// ─────────────────────────────────────────────────────────────────────────────

const makeSubQueryBuilder = (order: string[]) => {
  // oxlint-disable-next-line typescript/no-explicit-any
  const queryBuilder: any = {
    alias: 'company',
    applyRowLevelPermissions: jest.fn(() => {
      order.push('permissions');

      return queryBuilder;
    }),
    getQuery: jest.fn(() => {
      order.push('getQuery');

      return 'SELECT 1';
    }),
    getParameters: jest.fn(() => ({})),
    parameters: {},
  };

  for (const method of [
    'select',
    'addSelect',
    'andWhere',
    'where',
    'groupBy',
    'addGroupBy',
    'setParameters',
    'setParameter',
    'limit',
    'offset',
    'orderBy',
    'addOrderBy',
  ]) {
    queryBuilder[method] = jest.fn(() => queryBuilder);
  }

  return queryBuilder;
};

const callBuildRankedRecordsStatement = (
  // oxlint-disable-next-line typescript/no-explicit-any
  subQueryBuilder: any,
) => {
  const service = Object.create(
    GroupByWithRecordsService.prototype,
    // oxlint-disable-next-line typescript/no-explicit-any
  ) as any;

  return service.buildRankedRecordsStatement({
    subQueryBuilder,
    columnsToSelect: { name: true },
    groupsResult: [{ stage_alias: 'NEW' }],
    groupByDefinitions: [
      { alias: 'stage_alias', expression: '"company"."stage"' },
    ],
    orderByForRecords: {},
    flatObjectMetadata: { nameSingular: 'company', fieldIds: [] },
    flatObjectMetadataMaps: {},
    flatFieldMetadataMaps: {},
    offsetForRecords: 0,
  });
};

describe('GroupByWithRecordsService — cloisonnement de la sous-requête', () => {
  it('applique les permissions sur la sous-requête', () => {
    const order: string[] = [];
    const subQueryBuilder = makeSubQueryBuilder(order);

    callBuildRankedRecordsStatement(subQueryBuilder);

    expect(subQueryBuilder.applyRowLevelPermissions).toHaveBeenCalled();
  });

  it('les applique AVANT de sérialiser la sous-requête', () => {
    const order: string[] = [];
    const subQueryBuilder = makeSubQueryBuilder(order);

    callBuildRankedRecordsStatement(subQueryBuilder);

    expect(order.indexOf('permissions')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('getQuery')).toBeGreaterThan(
      order.indexOf('permissions'),
    );
  });
});
