import { Brackets, type ObjectLiteral } from 'typeorm';
import { isDefined } from 'twenty-shared/utils';

import { GraphqlQueryFilterFieldParser } from 'src/engine/api/graphql/graphql-query-runner/graphql-query-parsers/graphql-query-filter/graphql-query-filter-field.parser';
import { isUserAuthContext } from 'src/engine/core-modules/auth/guards/is-user-auth-context.guard';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { buildFieldMapsFromFlatObjectMetadata } from 'src/engine/metadata-modules/flat-field-metadata/utils/build-field-maps-from-flat-object-metadata.util';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { type WorkspaceInternalContext } from 'src/engine/twenty-orm/interfaces/workspace-internal-context.interface';
import { type WorkspaceSelectQueryBuilder } from 'src/engine/twenty-orm/repository/workspace-select-query-builder';
import {
  countryIsosOfScope,
  readMemberCountryScopeField,
  readMemberScopesField,
  resolveScope,
  SCOPE_PATH_FIELD,
  scopeTokenPattern,
} from 'src/engine/twenty-orm/utils/resolve-country-scope.util';

// Cloisonnement par pays (AGPL, autonome). Branché au choke-point ORM unique
// `WorkspaceSelectQueryBuilder.validatePermissions()`, après les checks object-level.
// N'importe ni ne réutilise le code Enterprise (`apply-row-level-permission-predicates.util.ts`),
// qui n'est qu'un patron de forme.
//
// La sémantique de `allowedCountries` elle-même vit dans `resolve-country-scope.util.ts`,
// parce qu'elle doit aussi servir aux chemins en contexte système que ce filtre laisse
// passer (onglet Emails, cf. `get-messages.service.ts`).

const COUNTRY_FIELD = 'countryCode';

// Objets de référence/catalogue sans rattachement pays (pas de donnée client
// confidentielle) : restent visibles par un utilisateur scoppé. TOUT autre objet
// sans `countryCode` est refusé par défaut (default-deny) — secure-by-default :
// un objet ajouté demain est invisible tant qu'il n'est pas explicitement traité
// (countryCode direct) ou ajouté ici. Étendre via les tests UI si une vue casse.
const COUNTRY_AGNOSTIC_OBJECTS = new Set<string>([
  'country', // référentiel des 76 pays
  'product', // catalogue produit (master data, non pays-spécifique)
  'workspaceMember', // annuaire interne Twenty (assignation, mentions, avatars)
  // Annuaire commercial interne : mêmes données que workspaceMember, vues du métier
  // (nom, email, territoire). Refuser `salesperson` alors que `workspaceMember` est
  // visible n'apportait aucune confidentialité et cassait toute vue portant le nom
  // du commercial.
  'salesperson',
  'salespersonCountry', // jonction commercial <-> pays du même annuaire
  // Objet de configuration : un dashboard ne porte pas de donnée client, ses widgets
  // interrogent les objets métier, qui restent filtrés à la source.
  'dashboard',
]);

// Objets « personnels » sans countryCode : un utilisateur scoppé voit SES propres
// enregistrements (ceux où il est impliqué), via un filtre d'appartenance par
// identité du membre courant. Le reste (notes/tâches d'autrui ou rattachées à des
// comptes hors scope) reste default-deny ; le transitif via les comptes in-scope
// du rep viendra en itération ultérieure (cf. audit).
const SELF_OWNED_FILTERS: Record<
  string,
  (workspaceMemberId: string) => { field: string; filter: object }
> = {
  task: (id) => ({ field: 'assigneeId', filter: { eq: id } }),
  note: (id) => ({
    field: 'createdBy',
    filter: { workspaceMemberId: { eq: id } },
  }),
  // Liste d'exclusion de synchronisation : donnée strictement personnelle, portée
  // par une FK directe vers le membre.
  blocklist: (id) => ({ field: 'workspaceMemberId', filter: { eq: id } }),
};

// ⚠️ Restent en default-deny, et c'est un manque assumé, pas un oubli. Mais la famille
// messagerie/agenda demande une distinction que ce commentaire affirmait à tort, et qui
// change la conception du lot B — mesuré sur DEV le 2026-08-11 :
//
// - `messageChannel`, `calendarChannel` et `messageFolder` sont des **coquilles** : leurs
//   données ont migré dans le schéma `core` (avec `connectedAccount`), hors du périmètre de
//   l'ORM workspace. Les objets de métadonnées existent encore et renvoient **0 ligne**,
//   alors que 3 canaux réels sont actifs et importent. Les refuser ici ne protège donc
//   RIEN, et c'est précisément pour ça que `messageChannel` n'expose plus de
//   `connectedAccountId` : le chemin `messageChannel -> connectedAccount.accountOwnerId`,
//   que ce commentaire proposait comme filtre d'appartenance, **n'existe pas** sur cette
//   surface. Corollaire : la visibilité native par canal
//   (`MessageChannelVisibility`, appliquée dans `timeline-messaging.service.ts`) vit dans
//   `core` et ce filtre ne peut pas la contredire.
//
// - le contenu, lui, est bien dans le workspace et bien refusé : `message`,
//   `messageThread`, `messageParticipant`, `messageChannelMessageAssociation`,
//   `messageChannelMessageAssociationMessageFolder`, `calendarEvent`,
//   `calendarEventParticipant`, `calendarChannelEventAssociation`. C'est là que se joue la
//   confidentialité, et la seule FK directe vers un membre de toute la famille est
//   `messageParticipant.workspaceMemberId` (et son équivalent
//   `calendarEventParticipant.workspaceMemberId`). Un filtre bâti sur elles seules rendrait
//   visibles deux objets de jonction et aucun message : la vraie réponse reste une colonne
//   dénormalisée, comme `scopePath` du lot B. À traiter là, pas par une rustine ici.
//
// - objets rattachés à un enregistrement client (`attachment`, `timelineActivity`,
//   `noteTarget`, `taskTarget`, `visitContact`, `mission`, `companyGroup`) : leur
//   portée est celle de leur parent. Même conclusion, même lot.
//
// Conséquence à connaître tant que ce n'est pas fait : un commercial scoppé n'a ni pièces
// jointes, ni historique, ni missions, et ne peut lire ni message ni événement d'agenda par
// une requête d'objet.
//
// ⚠️ Avant de lever ce refus, connaître ce qui a été mesuré le 2026-08-11 sur la requête
// d'objet générique `messages`, avec un contexte qui n'est pas propriétaire du canal :
// `subject` et `text` reviennent tous deux à la valeur
// `FIELD_RESTRICTED_ADDITIONAL_PERMISSIONS_REQUIRED`, alors que `receivedAt` reste lisible.
// La visibilité native par canal s'applique donc **au-delà de l'onglet Emails** : lever le
// refus ici exposerait les métadonnées (dates, fils, participants) mais pas le contenu, tant
// que la visibilité du canal n'est pas `SHARE_EVERYTHING`. C'est une option de conception
// réelle, moins chère que la colonne dénormalisée — mais elle se décide sur la valeur
// effective de `MessageChannelVisibility`, qui vit dans `core` et n'est lisible ni par ce
// filtre ni par une clé API. À trancher depuis Settings → Accounts, pas depuis ce fichier.
//
// TRANCHÉ le 2026-08-11, et pas dans le sens espéré : le refus est MAINTENU. Deux raisons.
//
// 1. Le défaut n'était pas `METADATA`. Aucun chemin de connexion réel n'envoie de
//    visibilité, et le fallback de `create-message-channel.service.ts` valait
//    `SHARE_EVERYTHING` : la visibilité native ne protégeait donc rien par défaut. Le
//    fallback est passé à `METADATA` pour que le raisonnement ci-dessus soit vrai.
// 2. Même sous `METADATA`, aucun hook de rédaction ne couvre `messageThread`,
//    `messageParticipant` ni `messageChannelMessageAssociation` : seuls `message` et
//    `calendarEvent` en ont un. Lever le refus exposerait donc le graphe « qui parle à qui,
//    quand » de tout le workspace, ce qui n'est pas une métadonnée anodine pour un
//    distributeur.
//
// À ne pas confondre avec un autre sujet, découvert au passage : les onglets Emails et
// Calendar ne passent PAS par ce filtre (contexte système), et sont cloisonnés séparément
// par `CountryScopeService`. Ce refus-ci n'a jamais eu d'effet sur eux.

type ApplyCountryPermissionFilterArgs<T extends ObjectLiteral> = {
  queryBuilder: WorkspaceSelectQueryBuilder<T>;
  objectMetadata: FlatObjectMetadata;
  internalContext: WorkspaceInternalContext;
  authContext: WorkspaceAuthContext;
};

export const applyCountryPermissionFilter = <T extends ObjectLiteral>({
  queryBuilder,
  objectMetadata,
  internalContext,
  authContext,
}: ApplyCountryPermissionFilterArgs<T>): void => {
  // 1. Bypass : seul un contexte utilisateur est filtré.
  //    Clé API serveur (ingestion) / contexte système ne sont JAMAIS filtrés.
  if (!isUserAuthContext(authContext)) {
    return;
  }

  // 2. Périmètre du membre courant : `allowedScopes` (jetons de portefeuille) d'abord,
  //    repli sur `allowedCountries` converti en jetons pays. Cf. `resolveScope` — c'est
  //    ce repli qui rend le déploiement sûr avant que la donnée de portée existe.
  //    Champs absents (workspace non provisionné) ou « tous pays » → no-op total. Champ
  //    présent mais vide ≠ absent : c'est un default-deny (un membre Snetor sans
  //    périmètre ne voit rien).
  const scope = resolveScope(
    readMemberScopesField(authContext.workspaceMember),
    readMemberCountryScopeField(authContext.workspaceMember),
  );

  if (scope.kind === 'unscoped') {
    return;
  }

  const { allowed } = scope;

  const { fieldIdByName } = buildFieldMapsFromFlatObjectMetadata(
    internalContext.flatFieldMetadataMaps,
    objectMetadata,
  );

  const hasCountryField = isDefined(fieldIdByName[COUNTRY_FIELD]);

  // 3. Objet porteur d'un `scopePath` ? → cloisonnement par portefeuille.
  if (isDefined(fieldIdByName[SCOPE_PATH_FIELD])) {
    if (allowed.length === 0) {
      denyAll(queryBuilder); // membre sans périmètre : ne voit rien
    } else {
      injectScopeFilter(
        queryBuilder,
        objectMetadata,
        internalContext,
        allowed,
        hasCountryField,
      );
    }
    return;
  }

  // 3b. Objet qui ne porte encore que `countryCode` → ancien filtre, avec les seuls
  //     jetons pays du périmètre.
  if (hasCountryField) {
    const isos = countryIsosOfScope(allowed);

    if (isos.length === 0) {
      denyAll(queryBuilder); // membre sans pays : ne voit rien
    } else {
      injectFieldFilter(queryBuilder, objectMetadata, internalContext, {
        field: COUNTRY_FIELD,
        filter: { in: isos },
      });
    }
    return;
  }

  // 4. Objet SANS `countryCode` : référentiel autorisé → visible.
  if (COUNTRY_AGNOSTIC_OBJECTS.has(objectMetadata.nameSingular)) {
    return;
  }

  // 4b. Objet « personnel » (note/task) : l'utilisateur voit SES enregistrements.
  const selfOwned = SELF_OWNED_FILTERS[objectMetadata.nameSingular];
  const workspaceMemberId = (authContext.workspaceMember as { id?: string }).id;

  if (selfOwned && isDefined(workspaceMemberId)) {
    injectFieldFilter(
      queryBuilder,
      objectMetadata,
      internalContext,
      selfOwned(workspaceMemberId),
    );
    return;
  }

  // 4c. Tout le reste (salesperson, mission, attachment, companyGroup,
  //     calendar/message…) → default-deny. Secure-by-default.
  denyAll(queryBuilder);
};

// Injecte le cloisonnement par portefeuille :
//
//   WHERE (   scopePath ILIKE '%|t1|%'
//          OR scopePath ILIKE '%|t2|%' …
//          OR ((scopePath IS NULL OR scopePath = '') AND countryCode IN (…)) )
//
// Un OU de `ILIKE` plutôt qu'un `IN` : c'est ce qui permet à un enregistrement de porter
// PLUSIEURS périmètres, mesuré nécessaire — un client sur trois est servi par plus d'un
// groupe de vendeurs (SAP, 2026-08-19). Le `IN` du filtre pays ne pouvait exprimer qu'un
// périmètre unique par enregistrement.
//
// ⚠️ La dernière branche est la contrainte liante du 2026-08-19 : une colonne `scopePath`
// PRÉSENTE ET VIDE se traite comme une colonne ABSENTE. `scopePath` n'est écrit que sur
// `company` ; sans ce repli, 3943 enregistrements basculeraient du repli au refus le jour
// du déploiement. `{ is: 'NULL' }` sur un champ TEXT produit `IS NULL OR = ''` — les deux
// cas d'un coup, cf. `findPostgresDefaultNullEquivalentValue`.
//
// ⚠️ Chaque appel au field parser est enveloppé dans SON PROPRE `Brackets`. Le parser
// pose du SQL brut sans parenthèses, et `A IS NULL OR A = '' AND cc IN (…)` n'a pas la
// précédence voulue.
//
// ponytail: ILIKE '%…%' n'utilise pas d'index. Sans effet à 2099 sociétés ; si la base
// dépasse ~100 000 enregistrements cloisonnés, passer à une table de jonction
// (jeton -> enregistrement) indexée, ou à un index GIN trigramme sur la colonne.
const injectScopeFilter = <T extends ObjectLiteral>(
  queryBuilder: WorkspaceSelectQueryBuilder<T>,
  objectMetadata: FlatObjectMetadata,
  internalContext: WorkspaceInternalContext,
  tokens: string[],
  hasCountryField: boolean,
): void => {
  const outerQueryBuilder =
    queryBuilder as WorkspaceSelectQueryBuilder<ObjectLiteral>;

  const parsedClause = (field: string, filter: object): Brackets =>
    new Brackets((inner) => {
      const fieldParser = new GraphqlQueryFilterFieldParser(
        objectMetadata,
        internalContext.flatFieldMetadataMaps,
      );

      fieldParser.parse(
        inner,
        outerQueryBuilder,
        objectMetadata.nameSingular,
        field,
        filter,
        true,
        false,
      );
    });

  const isos = countryIsosOfScope(tokens);

  const condition = new Brackets((qb) => {
    tokens.forEach((token, index) => {
      const clause = parsedClause(SCOPE_PATH_FIELD, {
        ilike: scopeTokenPattern(token),
      });

      if (index === 0) {
        qb.where(clause);
      } else {
        qb.orWhere(clause);
      }
    });

    if (hasCountryField && isos.length > 0) {
      qb.orWhere(
        new Brackets((fallback) => {
          fallback
            .where(parsedClause(SCOPE_PATH_FIELD, { is: 'NULL' }))
            .andWhere(parsedClause(COUNTRY_FIELD, { in: isos }));
        }),
      );
    }
  });

  appendCondition(queryBuilder, condition);
};

// Injecte `WHERE <field> <filter>` via le field parser GraphQL (gère l'alias, les
// params, les champs composites comme `createdBy`). Utilisé pour countryCode
// (`{ in: [...] }`) comme pour l'appartenance (`assigneeId`/`createdBy`).
const injectFieldFilter = <T extends ObjectLiteral>(
  queryBuilder: WorkspaceSelectQueryBuilder<T>,
  objectMetadata: FlatObjectMetadata,
  internalContext: WorkspaceInternalContext,
  { field, filter }: { field: string; filter: object },
): void => {
  // parseKeyFilter (Enterprise, privé) délègue son default case à
  // GraphqlQueryFilterFieldParser.parse — on appelle directement le parser public.
  // Il ne sert que la surface de jointure, on élargit donc à ObjectLiteral.
  const outerQueryBuilder =
    queryBuilder as WorkspaceSelectQueryBuilder<ObjectLiteral>;

  const condition = new Brackets((qb) => {
    const fieldParser = new GraphqlQueryFilterFieldParser(
      objectMetadata,
      internalContext.flatFieldMetadataMaps,
    );

    fieldParser.parse(
      qb,
      outerQueryBuilder,
      objectMetadata.nameSingular,
      field,
      filter,
      true,
      false,
    );
  });

  appendCondition(queryBuilder, condition);
};

// Default-deny : un objet non rattaché à un pays (et hors allowlist) est invisible
// pour un utilisateur scoppé.
const denyAll = <T extends ObjectLiteral>(
  queryBuilder: WorkspaceSelectQueryBuilder<T>,
): void => {
  appendCondition(
    queryBuilder,
    new Brackets((qb) => {
      qb.where('1 = 0');
    }),
  );
};

// Ajoute la condition en AND avec les WHERE existants (ou en WHERE si aucun).
const appendCondition = <T extends ObjectLiteral>(
  queryBuilder: WorkspaceSelectQueryBuilder<T>,
  condition: Brackets,
): void => {
  if (queryBuilder.expressionMap.wheres.length === 0) {
    queryBuilder.where(condition);
  } else {
    queryBuilder.andWhere(condition);
  }
};
