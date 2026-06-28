# Spike — cloisonnement par pays (Partie B)

> Note de spike (B1). Pin des imports/accès vérifiés dans le code (pas deviné) avant d'écrire
> l'util AGPL. Conservée en doc dans le dossier `utils/` à côté de l'util.

## Contexte

Filtre record-level AGPL injecté au choke-point ORM unique
`WorkspaceSelectQueryBuilder.validatePermissions()`
(`src/engine/twenty-orm/repository/workspace-select-query-builder.ts`), branché **après**
`applyRowLevelPermissionPredicates()`.

Le fichier Enterprise `apply-row-level-permission-predicates.util.ts` sert de **patron de forme
UNIQUEMENT** (`@license Enterprise` — jamais importé/copié). Notre util est autonome et AGPL.

## Step 1 — Chemins d'import exacts (vérifiés)

| Symbole | Import |
|---|---|
| `Brackets`, `ObjectLiteral` | `from 'typeorm'` |
| `isUserAuthContext` | `src/engine/core-modules/auth/guards/is-user-auth-context.guard` |
| `WorkspaceAuthContext` | `src/engine/core-modules/auth/types/workspace-auth-context.type` |
| `WorkspaceSelectQueryBuilder` | `src/engine/twenty-orm/repository/workspace-select-query-builder` |
| `WorkspaceInternalContext` | `src/engine/twenty-orm/interfaces/workspace-internal-context.interface` |
| `FlatObjectMetadata` | `src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type` |
| `GraphqlQueryFilterFieldParser` | `src/engine/api/graphql/graphql-query-runner/graphql-query-parsers/graphql-query-filter/graphql-query-filter-field.parser` |
| `buildFieldMapsFromFlatObjectMetadata` | `src/engine/metadata-modules/flat-field-metadata/utils/build-field-maps-from-flat-object-metadata.util` |
| `isDefined` | `twenty-shared/utils` |

**`parseKeyFilter` n'est PAS importable** : c'est une fonction privée (non exportée) **du fichier
Enterprise**. On ne la réutilise donc pas. À sa place on appelle directement
`GraphqlQueryFilterFieldParser.parse(...)`, qui est précisément ce que le `default:` de
`parseKeyFilter` délègue (vérifié l.238-247 du fichier Enterprise). Signature publique vérifiée
(`graphql-query-filter-field.parser.ts` l.58) :

```ts
parse(queryBuilder, outerQueryBuilder, objectNameSingular, key, filterValue, isFirst, useDirectTableReference)
```

Pour un champ scalaire TEXT, `filterValue = { in: allowed }` passe par `computeWhereConditionParts`
(l.118) et produit `WHERE "<alias>"."countryCode" IN (:...)`. `in` est dans `ARRAY_OPERATORS` ;
**le parser lève si le tableau est vide** (l.108-117) → on ne l'appelle JAMAIS avec `allowed=[]`
(default-deny géré à part, cf. Step + util).

## Step 2 — Accès au champ d'un objet par nom (vérifié)

⚠️ **Le code du plan était faux** : `objectMetadata.fieldIds.map(id => flatFieldMetadataMaps.byUniversalIdentifier[id])`
ne marche pas. `fieldIds` contient des **IDs d'entité**, alors que `byUniversalIdentifier` est keyé
par **universalIdentifier**. La résolution canonique est en deux temps
(`find-flat-entity-by-id-in-flat-entity-maps-or-throw.util.ts` l.23-33) :
`universalIdentifierById[fieldId]` → `byUniversalIdentifier[universalIdentifier]`.

**Ligne exacte retenue** (réutilise le helper canonique du repo, déjà utilisé par le field parser) :

```ts
const { fieldIdByName } = buildFieldMapsFromFlatObjectMetadata(
  internalContext.flatFieldMetadataMaps,
  objectMetadata,
);
const hasCountryCode = isDefined(fieldIdByName[COUNTRY_FIELD]);
```

`buildFieldMapsFromFlatObjectMetadata` (vérifié) construit `fieldIdByName` à partir des champs réels
de l'objet → un objet est « cloisonné » ssi `countryCode` ∈ `fieldIdByName`. Bonus : ce même helper
est ce dont `GraphqlQueryFilterFieldParser` se sert en interne → cohérence garantie.

## Step 3 — `workspaceMember.allowedCountries` hydraté dans authContext (vérifié)

`authContext` (type `user`) porte `workspaceMember: WorkspaceMemberWorkspaceEntity`
(`raw-auth-context.type.ts` l.14). Les **champs custom** ne sont pas sur ce type statique, mais
sont **hydratés au runtime** — c'est exactement ce dont dépend la RLS Enterprise
(`apply-row-level-permission-predicates.util.ts` l.50-52 passe `authContext.workspaceMember` au
record-filter builder qui lit ses champs custom). Lecture résiliente au typage (le champ custom
n'est pas dans le type) via la même forme que le patron :

```ts
const raw = Object.entries(authContext.workspaceMember).find(
  ([k]) => k === MEMBER_SCOPE_FIELD,
)?.[1] as string | undefined;
```

Repli (non requis a priori) : lookup repository sur le workspaceMember courant. Non implémenté en
v1 (l'hydratation runtime suffit, prouvée par l'usage RLS).

## Step 4 — Chemin du filtre `mission` par rep — DÉCISION : différé itération 2

`mission` est un **objet custom** (défini côté `client-matrix/ingestion/src/twenty_schema.py`,
PAS un objet standard du fork). Il porte bien une relation directe vers le workspaceMember :
`salesRep` (RELATION → `workspaceMember`) → join-column `salesRepId`. Un filtre
`WHERE salesRepId = currentWorkspaceMemberId` est donc *théoriquement* possible.

**MAIS** : `mission` n'a **pas** de champ `countryCode` (filtré par rep, pas par pays). Le filtrer
exigerait un **second mécanisme** (match FK `salesRepId` = `authContext.workspaceMemberId`),
distinct du filtre uniforme `countryCode IN (...)`. Cela élargit l'util au-delà du patron uniforme
v1 et introduit une logique de join-column spécifique.

**Décision (conforme au plan B1 Step 4)** : **différer `mission` en itération 2**. En v1, l'util ne
filtre QUE les objets portant `countryCode` → `mission` (sans `countryCode`) est traité comme
« non cloisonné » et **n'est PAS filtré**.

**Conséquence à consigner (runbook + go-live pilote)** : tant que le filtre `mission` par rep n'est
pas livré, **`mission` doit être exclu des objets exposés aux sales du pilote** (sinon un sales voit
toutes les missions, tous reps confondus). À traiter en itération 2 :
`WHERE "salesRepId" = :currentWorkspaceMemberId`.

## Step 5 — Commandes build/test serveur (vérifiées)

- Jest (un fichier ciblé), depuis `packages/twenty-server` :
  `npx jest apply-country-permission-filter`
  (`jest.config.mjs` : `testRegex = .*\.spec\.ts$`, transform `@swc/jest`).
- Typecheck : `npx tsc --noEmit -p tsconfig.json` (le repo utilise nx ; `tsc --noEmit` suffit pour
  un check local du package serveur).
- Monorepo yarn 4.13 (corepack peut échouer en EPERM sous Windows) → invoquer le yarn vendoré :
  `node .yarn/releases/yarn-4.13.0.cjs install`.
