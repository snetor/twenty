# La carte du fork Snetor

Ce fichier existe pour une seule raison : **rendre la prochaine montée de version mécanique au lieu
qu'elle soit archéologique.** Il dit ce que Snetor a ajouté à Twenty, où exactement chaque
modification s'accroche au code amont, et ce qui casse quand l'amont bouge.

Il se met à jour **dans la même pull request** que la modification qu'il décrit. Un fichier de
carte en retard est pire qu'absent : il fait chercher au mauvais endroit.

> **État décrit** : fork sur `twenty/v2.39.0`.
> Mesure de l'écart avec l'amont : `git diff --stat twenty/v2.39.0 HEAD`.
>
> **Ce que la montée 2.30 → 2.39 a changé pour ce fichier**, et c'est le résumé le plus
> utile qu'il porte : le cloisonnement est passé de **cinq points d'application dispersés à
> deux**, tous deux sur des interfaces publiques ; le chantier « visibilité messagerie » a
> **disparu**, absorbé par l'amont ; et les surfaces en contexte système (Emails, Calendar,
> agent) restent les seules à demander un rappel manuel du périmètre.

---

## 1. La règle d'or — où accrocher un patch

**Un patch accroché à une interface publique survit aux montées de version. Un patch glissé au
milieu du corps d'une méthode privée part avec la méthode, sans bruit et sans erreur de
compilation.**

Ce n'est pas une opinion, c'est une mesure. Entre `twenty/v2.30.0` et `twenty/v2.39.0`, sur les
cinq points d'ancrage du fork :

| Ancrage | Nature | Survie |
|---|---|---|
| `@WorkspaceQueryHook('*.createOne')` | décorateur — interface publique d'extension | ✅ intact |
| `navigateToRecord` + `selectColumns` | méthode privée, mais peu touchée | ✅ intact |
| `validatePermissions()` | corps de méthode **privée** | ❌ disparue |
| `execute()` des builders de mutation | corps de méthode, ×3 | ❌ fichiers supprimés |
| `addPartitionByToQueryBuilder` | corps de méthode **privée** | ❌ disparue |

**Trois sur cinq perdus en neuf releases.** Et le danger n'est pas la perte : c'est qu'elle est
**silencieuse**. Le code compile, les tests ordinaires passent, et le cloisonnement ne filtre plus
rien.

### Conséquences pratiques, par ordre de préférence

1. **Un listener d'événement** (`@OnDatabaseBatchEvent`) plutôt qu'un patch de méthode. C'est le
   choix fait pour `ScopeAssignmentListener` et `ScopePathOnCreateListener`, et il est justifié
   dans le code même : un listener survit aux fusions, un patch de méthode non.
2. **Un hook de requête** (`@WorkspaceQueryHook`) plutôt qu'une modification de service. C'est le
   choix du chantier « dérivation `countryCode` » — le seul chantier du fork qui n'a rien coûté à
   la montée 2.39.
3. **Un fichier entièrement nouveau** plutôt qu'une modification. 30 des 49 fichiers du fork sont
   des ajouts : ils représentent 97 % des lignes et **zéro conflit possible**.
4. En dernier recours seulement, un patch dans du code amont — et alors **il lui faut une
   spec-sentinelle** (§4).

### Ce que la montée v2.39.0 a permis, et qu'il faut préserver

La règle n'est pas qu'une précaution : appliquée, elle **réduit** le fork. En reposant le
cloisonnement sur `WorkspaceRepository.onBeforeExecute()` et `runMutation()` — un hook de contexte
et une méthode publique — les cinq points d'application sont devenus **deux**, et trois surfaces
qui demandaient chacune leur patch (le groupBy du Kanban, les relations imbriquées, les comptages)
sont désormais couvertes sans une ligne de code Snetor.

Chaque fois qu'un choix se présente entre « patcher là où ça se voit » et « remonter au point par
où tout passe », c'est le second qu'il faut prendre, même s'il demande une demi-journée de lecture
de plus. Le fork ne se juge pas au nombre de lignes qu'il ajoute mais au nombre d'endroits où il
doit être rebranché à chaque montée.

⚠️ **Et un coin à ne pas couper : ne jamais importer un fichier amont marqué `/* @license
Enterprise */`.** `render-row-level-permission-filter-to-sql.util.ts` et
`apply-row-level-permission-predicates.util.ts` font exactement ce dont notre filtre a besoin, et
sont interdits d'usage. Ils servent de **patron de forme**, jamais de dépendance. Les briques de
bas niveau, elles, sont libres : `compute-where-condition-parts.ts`,
`graphql-query-filter-field.parser.ts` et `workspace-repository.ts` ne portent pas ce marqueur —
vérifier avec `head -1` avant d'importer quoi que ce soit de nouveau.

---

## 2. La règle de généalogie — ne jamais squasher une montée

**Une pull request qui fusionne l'amont ne se merge JAMAIS en squash.**

Incident, le 2026-09-14. La PR #17 avait intégré `twenty/v2.30.0` dans le fork. Elle a été mergée
en squash, donc le commit `5016dc8901` n'a **qu'un seul parent** :

```
git log --format="%h parents=[%p] %s" -1 5016dc8901
5016dc8901 parents=[616c6a305f] chore(upgrade): fusionner twenty/v2.30.0 dans le fork (#17)
```

Le contenu de la 2.30 était bien là. Mais la **généalogie** avait disparu : git ignorait que le
fork contenait déjà cette version, et calculait son merge-base sur `b60a91a075`, du 2026-06-05.
Trois mois d'écart au lieu de zéro. Le merge de `twenty/v2.39.0` rendait alors **2 714 fichiers en
conflit** au lieu de 14.

ELI8 : le fork avait bien déménagé dans la maison 2.30, meubles compris. Mais personne n'avait
signé le changement d'adresse. Git croyait qu'on habitait encore l'ancienne et voulait tout
redéménager depuis là.

### 🟢 La cause a été retirée le 2026-09-15

Le squash n'était pas une négligence : `main` portait la règle **`required_linear_history`**, qui
**interdit les merge commits**. Un historique linéaire est un historique sans embranchement — or un
merge amont EST un embranchement, et c'est précisément lui qui enregistre « nous descendons aussi
de la 2.39 ». La règle interdisait donc d'écrire l'information dont la montée suivante a besoin.

Elle a été retirée du ruleset `Protect core branches` (id `17310656`). **Ce qui reste protégé sur
`main`, `snetor/main` et `snetor/prod`** : suppression de branche interdite (`deletion`), force
push interdit (`non_fast_forward`), et une approbation obligatoire (`pull_request`,
`required_approving_review_count: 1`).

Vérification :

```
gh api repos/snetor/twenty/rules/branches/main --jq '.[].type'
→ deletion, non_fast_forward, pull_request
```

Si `required_linear_history` réapparaît un jour dans cette liste, le piège est revenu.

### La réparation, si le cas se reproduit

Vérifier d'abord que le contenu est bien celui du tag — seuls les fichiers du fork doivent
s'en écarter :

```
git diff --stat twenty/vX.Y.Z HEAD
```

Puis enregistrer le fait, sans modifier un seul fichier :

```
git merge -s ours twenty/vX.Y.Z -m "chore(upgrade): enregistrer twenty/vX.Y.Z comme ancetre du fork"
```

La stratégie `ours` ne change aucun contenu ; elle ajoute uniquement le second parent qui manquait.

### Et la règle qui évite d'en arriver là

Sur le dépôt, la politique Snetor est « squash merge + suppression auto de la branche ». Elle est
juste pour une PR de fonctionnalité. Elle est **destructrice** pour une PR de montée amont.
Celles-ci se mergent en **merge commit**, sans exception.

---

## 3. Les six chantiers

### Chantier 1 — Cloisonnement par portée (`scopePath`, repli `countryCode`)

**But métier** : un commercial ne voit et ne modifie que les sociétés, contacts, opportunités,
visites et produits-clients de son portefeuille SAP, avec repli sur son pays.

**Fichiers ajoutés** (aucun conflit possible) :

```
engine/twenty-orm/utils/resolve-country-scope.util.ts          sémantique pure du périmètre
engine/twenty-orm/utils/apply-country-permission-filter.util.ts cœur du filtre
engine/twenty-orm/utils/COUNTRY_FILTER_SPIKE.md                 chemins d'import vérifiés
engine/core-modules/country-scope/country-scope.module.ts
engine/core-modules/country-scope/services/country-scope.service.ts
engine/core-modules/country-scope/listeners/scope-assignment.listener.ts
engine/core-modules/country-scope/listeners/scope-path-on-create.listener.ts
```

`resolve-country-scope.util.ts` n'a **aucune dépendance NestJS ni TypeORM**. C'est le fichier le
plus stable du fork, et c'est délibéré : toute la sémantique du périmètre y est isolée du
framework. Il exporte `ALL_COUNTRIES`, `MEMBER_SCOPES_FIELD`, `SCOPE_PATH_FIELD`,
`SALESPERSON_SCOPE_TOKENS_FIELD`, `COUNTRY_TOKEN_PREFIX`, et les fonctions `resolveScope`,
`isScopeInScope`, `countryIsosOfScope`, `buildRecordScopePath`.

`apply-country-permission-filter.util.ts` porte la décision : sortie immédiate si le contexte n'est
pas un utilisateur ou si la portée est `unscoped` ; filtre sur `scopePath` par `ILIKE` de jetons ;
repli sur `countryCode` ; allow-list `COUNTRY_AGNOSTIC_OBJECTS` (`country`, `product`,
`workspaceMember`, `salesperson`, `salespersonCountry`, `dashboard`) ; table `SELF_OWNED_FILTERS` ;
puis **`denyAll()` en default-deny**.

**Patchs dans du code amont — DEUX, tous deux dans `twenty-orm/repository/workspace-repository.ts` :**

| Point d'ancrage | Ce qu'il couvre | Fragilité |
|---|---|---|
| `onBeforeExecute()` — un appel après `applyRowLevelPermissionPredicates` | **toute la LECTURE.** `createQueryBuilder()` injecte ce hook dans chaque builder de lecture : `find`, `getCount()`, le groupBy du Kanban (via `applyRowLevelPermissions()`), les relations imbriquées | 🟢 hook d'un contexte, interface publique |
| `runMutation()` — un appel sous la même condition `if (!rowLevelPermissionsApplied)` que l'amont | **toute l'ÉCRITURE.** update, delete, soft-delete, restore | 🟢 méthode publique |

Plus la méthode privée `applyCountryPermissionFilterPredicate()` qui les sert, ajoutée au même
fichier.

**Avant la v2.39.0 il en fallait cinq**, dont trois au milieu de corps de méthodes privées que
l'amont a supprimées depuis. C'est la démonstration de la règle d'or, et la raison de ne jamais
revenir à des points d'application dispersés : chaque surface patchée séparément est une surface
qu'on peut oublier — c'est exactement ainsi que l'écriture est restée non cloisonnée jusqu'au
2026-08-30.

⚠️ **Écart connu, hérité de la 2.30 et à réévaluer** : notre filtre porte sur l'alias principal,
alors que `applyRowLevelPermissionPredicates` itère désormais aussi sur `getJoinAliases()`. Le
nouveau moteur expose `markRowLevelPermissionApplied(alias)` et `addJoinCondition(alias, sql)` :
il y a là de quoi étendre le cloisonnement aux relations jointes, ce qui n'était pas faisable avant.

⚠️ **Le `clone()` d'un builder conserve son contexte**, donc son hook — c'est ce qui fait que le
groupBy est couvert sans patch. Il recopie aussi `aliasesWithRowLevelPermissionApplied`, alors que
notre filtre n'a pas d'équivalent : une double application reste donc possible sur un clone. Elle
est inoffensive (un `AND` identique deux fois, jamais moins restrictif), mais à connaître avant de
s'étonner d'un SQL redondant.

⚠️ **L'incident qui justifie les deux appels dans l'update** : pendant des semaines, le
cloisonnement ne filtrait que la **lecture**. Les trois builders de mutation n'appliquaient rien,
et un `UPDATE` n'a pas de `SELECT` préalable. Un commercial pouvait modifier une fiche qu'il ne
pouvait pas voir.

---

### Chantier 2 — Dérivation automatique de `countryCode`

**But métier** : un enregistrement créé en interface ou par API porte toujours son `countryCode`,
sinon il naît **invisible pour tout le monde** (default-deny), y compris pour son auteur.

**Fichiers ajoutés** :

```
engine/core-modules/country-code-derivation/country-code-derivation.module.ts
engine/core-modules/country-code-derivation/utils/derive-country-code.util.ts
engine/core-modules/country-code-derivation/services/country-code-from-relation.service.ts
engine/core-modules/country-code-derivation/query-hooks/country-code.create-one.pre-query-hook.ts
engine/core-modules/country-code-derivation/query-hooks/country-code.create-many.pre-query-hook.ts
engine/core-modules/country-code-derivation/query-hooks/country-code.update-one.pre-query-hook.ts
engine/core-modules/country-code-derivation/query-hooks/country-code.update-many.pre-query-hook.ts
```

**Patch amont** : une seule ligne, `CountryCodeDerivationModule,` dans le tableau `imports:` de
`engine/core-modules/core-engine.module.ts`.

🟢 **C'est le chantier le plus sûr du fork, et le modèle à suivre.** Tout passe par le décorateur
`@WorkspaceQueryHook('*.createOne')` — une interface publique d'extension — et une ligne dans un
module NestJS. Il a traversé la montée 2.30 → 2.39 sans une seule retouche.

Le service lit la clé étrangère en base sous `{ shouldBypassPermissionChecks: true }`, et il est
**no-op si le champ `countryCode` n'existe pas** dans le workspace. Un échec de lecture n'empêche
jamais l'écriture.

---

### Chantier 3 — Visibilité de la messagerie par défaut — 🟢 RETIRÉ le 2026-09-14

**But métier** : un compte email ou agenda connecté depuis Settings → Accounts ne partage par
défaut que les **métadonnées**, pas le corps des mails, à l'ensemble du workspace.

**Le patch n'existe plus.** Le fork imposait `METADATA` depuis la PR #11 ; en `twenty/v2.39.0`
l'amont porte exactement la même valeur :

```
core-modules/auth/services/create-message-channel.service.ts:54
    visibility: messageVisibility || MessageChannelVisibility.METADATA
core-modules/auth/services/create-calendar-channel.service.ts:49
    visibility: calendarVisibility || CalendarChannelVisibility.METADATA
```

Le patch a donc été retiré à la montée : deux fichiers amont de moins à porter, définitivement.

⚠️ **Mais les deux specs sont CONSERVÉES, et c'est le point à ne pas rater.** Une dépendance qu'on
ne patche plus est une dépendance que plus rien ne surveille. Si une release future revenait à
`SHARE_EVERYTHING`, le corps des mails de tous les commerciaux serait repartagé au workspace
entier — sans conflit de merge, sans erreur de compilation, sans aucun signal. Ces deux specs sont
le seul endroit qui s'en apercevrait. Ne pas les supprimer au motif qu'elles « ne défendent plus
de code Snetor ».

---

### Chantier 4 — Surfaces en contexte système (Emails, Calendar, agent)

**But métier** : les onglets Emails et Calendar d'une fiche, et l'outil `navigate_app` de l'agent,
ne remontent pas de données hors périmètre.

**Pourquoi un chantier séparé** : ces chemins tournent sous `buildSystemAuthContext`, un contexte
technique qui **échappe au filtre ORM** du chantier 1. Le périmètre doit y être rejoué à la main,
via `CountryScopeService.keepPersonIdsInScope`.

**Patchs amont** :

| Fichier | Nature du patch | Fragilité |
|---|---|---|
| `core-modules/messaging/services/get-messages.service.ts` | injection au constructeur + bloc `keepPersonIdsInScope` + early-return + **3 substitutions** `personIds` → `personIdsInScope` | 🔴 substitutions dispersées |
| `core-modules/calendar/timeline-calendar-event.service.ts` | idem, avec `currentWorkspaceMemberId` comme identité + substitutions dans le `where`, le retour anticipé et 2 `relatedPersonIds` | 🔴 idem. L'amont y a réécrit 517 lignes à la v2.39.0 |
| `core-modules/tool/tools/navigate-tool/navigate-app-tool.ts` | injection + signature élargie + renommages `selectColumns` → `baseSelectColumns` et `records` → `allRecords` + `.filter(isScopeInScope(...))` | 🔴 **le patch le plus intrusif du fork** |
| `core-modules/messaging/timeline-messaging.module.ts` | `CountryScopeModule,` dans `imports:` | 🟢 stable |
| `core-modules/calendar/timeline-calendar-event.module.ts` | idem | 🟢 stable |
| `core-modules/tool/tool.module.ts` | idem | 🟠 placé au milieu d'un bloc trié — contrarie `oxfmt` |

⚠️ **Le piège de `navigate-app-tool.ts`, à relire à chaque montée** : si les champs de portée ne
sont pas ajoutés au `select`, `isScopeInScope` les lit `undefined` et **laisse tout passer**. Le
filtre a l'air actif et ne filtre rien.

⚠️ **Le piège des substitutions** : un merge peut très bien accepter le bloc d'en-tête et perdre
une seule substitution en profondeur. Le filtre devient alors partiellement inopérant, **sans aucun
signal**. Contrôle : après tout merge, `grep -n "personIds\b"` sur les deux services — aucune
occurrence nue ne doit subsister après le calcul de `personIdsInScope`.

🔴 **Le piège nouveau, apparu à la v2.39.0 — `IS_MESSAGE_CALENDAR_TARGET_READ_ENABLED`.**
L'amont a ajouté un `targetFilter` qui sélectionne les threads et les événements **par
l'enregistrement cible** (`messageThreadTarget` / `calendarEventTargets`) et non plus par les
personnes. Notre périmètre, lui, ne porte que sur `personIds`.

Tant que ce drapeau est éteint, `resolveTargetFilter` rend `undefined` et le cloisonnement reste
complet. Son seul `true` du dépôt est dans le seeder de développement
(`seed-feature-flags.util.ts`), donc il est absent d'un workspace réel.

**L'allumer sans avoir étendu le cloisonnement à `targetFilter` ouvrirait l'onglet Emails et
l'onglet Calendar d'un enregistrement hors portée.** Les deux services portent le rappel en
commentaire, à l'endroit exact où il faudrait agir.

---

### Chantier 5 — CI et déploiement Azure

**But métier** : le fork construit son image vers l'ACR privé Snetor et pilote la landing zone en
GitOps, sans être bloqué par les workflows amont qui exigent des secrets `twentyhq`.

| Fichier | Geste |
|---|---|
| `.github/workflows/snetor-deploy.yaml` | **ajouté** — build, push ACR, puis réécriture de la balise d'image dans `snetor/azure-landing-zone`. Le préfixe `snetor-` garantit qu'il n'entrera jamais en conflit avec l'amont |
| `.github/workflows/ci-app-docs-drift.yaml` | **patché** — garde `github.repository == 'twentyhq/twenty' &&` en tête du `if:` |
| `.github/workflows/pr-review-dispatch.yaml` | **patché** — même garde |
| `.github/workflows/external-contributor-pr-auto-draft.yaml` | **supprimé** — il mint un token d'App GitHub vers `twentyhq/ci-privileged` avec des credentials que le fork n'a pas |

⚠️ **Un fichier supprimé chez nous et modifié chez l'amont produit un conflit que le merge peut
résoudre en le RESSUSCITANT.** À vérifier explicitement à chaque montée :

```
git ls-tree HEAD -- .github/workflows/external-contributor-pr-auto-draft.yaml
```

Attendu : vide.

---

### Chantier 6 — Documentation du fork

`README.md` reçoit un bloc en **tête** de fichier, `CLAUDE.md` une section en **fin**. L'amont
modifie régulièrement l'en-tête du README (badges) : conflit récurrent, mais bénin.

---

## 4. Les quatre specs-sentinelles

Ce sont des tests écrits pour **échouer si un merge fait sauter un patch**. Ils ne testent pas une
fonctionnalité : ils testent que l'accroche existe encore. **Ils se lancent avant tout le reste
après un merge.**

| Spec | Ce qu'elle défend |
|---|---|
| `twenty-orm/repository/__tests__/workspace-repository-country-filter.spec.ts` | les **deux** points d'application : `onBeforeExecute` pour la lecture, `runMutation` pour l'écriture |
| `group-by/services/__tests__/group-by-with-records-country-filter.spec.ts` | que `applyRowLevelPermissions()` précède `getQuery()` dans `buildRankedRecordsStatement` — donc que la sous-requête du Kanban est sérialisée **après** le filtre |
| `auth/services/create-message-channel.service.spec.ts` | que le défaut de visibilité reste `METADATA` |
| `auth/services/create-calendar-channel.service.spec.ts` | idem pour l'agenda |

Elles étaient cinq avant la v2.39.0 : celles du select builder et des trois builders de mutation
ont fusionné, parce que les points d'application ont fusionné.

**Deux d'entre elles ne défendent plus une ligne de code Snetor** — celles des canaux, depuis que
l'amont a adopté notre défaut ; et celle du groupBy, depuis que le hook rend le patch inutile.
C'est justement ce qui les rend précieuses : elles surveillent des **dépendances invisibles**, des
comportements amont dont notre confidentialité dépend sans qu'aucun conflit de merge ne vienne
jamais nous avertir s'ils changent. Ne pas les supprimer au motif qu'elles ne couvrent « rien à
nous ».

Si l'une échoue après un merge : **un patch a sauté. Ne pas continuer, ne pas la réparer en
ajustant l'attente.** Retrouver où l'accroche a disparu.

### L'inventaire des tests du fork — 13 fichiers, 153 cas

Mesure du 2026-09-15, sur la branche de montée v2.39.0 :

```
Test Suites: 13 passed, 14 total
Tests:       153 passed, 154 total
```

```
src/engine/twenty-orm/utils/__tests__/apply-country-permission-filter.util.spec.ts
src/engine/twenty-orm/utils/__tests__/resolve-country-scope.util.spec.ts
src/engine/twenty-orm/repository/__tests__/workspace-repository-country-filter.spec.ts   ← sentinelle
src/engine/core-modules/country-scope/services/__tests__/country-scope.service.spec.ts
src/engine/core-modules/country-scope/listeners/__tests__/scope-path-on-create.listener.spec.ts
src/engine/core-modules/country-scope/listeners/__tests__/scope-assignment.listener.spec.ts
src/engine/core-modules/country-code-derivation/utils/__tests__/derive-country-code.util.spec.ts
src/engine/core-modules/country-code-derivation/services/__tests__/country-code-from-relation.service.spec.ts
src/engine/core-modules/tool/tools/navigate-tool/__tests__/navigate-app-tool.spec.ts
src/engine/core-modules/messaging/services/__tests__/get-messages.service.spec.ts
src/engine/api/graphql/.../group-by/services/__tests__/group-by-with-records-country-filter.spec.ts  ← sentinelle
src/engine/core-modules/auth/services/create-message-channel.service.spec.ts              ← sentinelle
src/engine/core-modules/auth/services/create-calendar-channel.service.spec.ts             ← sentinelle
```

⚠️ **Comment les lancer sur ce poste.** `packages/twenty-shared` doit être construit avant, sinon
jest échoue sur `Cannot find module 'twenty-shared/utils'` — ses exports pointent vers `dist/` :

```
NX_DAEMON=false ./node_modules/.bin/nx build twenty-shared --skip-nx-cache
```

Sans `NX_DAEMON=false`, ce build reste bloqué indéfiniment sur son étape `generateBarrels`, sans
rien écrire et sans consommer de CPU — un blocage silencieux qui ressemble à une lenteur. Même
chose pour `twenty-oxlint-rules`, exigé par `oxlint`.

---

## 5. Ce qu'aucun test ne rattrapera

Quatre choses qu'un humain doit relire à l'œil après chaque montée :

1. **Les substitutions `personIds` → `personIdsInScope`** — sur les deux services de timeline. Un
   merge peut en perdre une seule, sans signal.
2. **Les renommages dans `navigate-app-tool.ts`** — `selectColumns` → `baseSelectColumns`,
   `records` → `allRecords`. Si les champs de portée quittent le `select`, `isScopeInScope` les lit
   `undefined` et **laisse tout passer** : le filtre a l'air actif et ne filtre rien.
3. **Les drapeaux de fonctionnalité amont qui changent la façon dont une donnée est sélectionnée.**
   `IS_MESSAGE_CALENDAR_TARGET_READ_ENABLED` en est le premier exemple (§ chantier 4) : il ne
   touche aucune ligne de notre code, ne produit aucun conflit, et déplace pourtant le critère de
   sélection hors de notre périmètre. À chaque montée, lire les nouveaux drapeaux qui touchent une
   lecture de données métier.
4. **La résurrection de `external-contributor-pr-auto-draft.yaml`.**

---

## 6. La dépendance hors dépôt — le piège le moins visible

**Tout le fork repose sur des champs qui ne sont pas dans ce dépôt.**

```
workspaceMember.allowedScopes       workspaceMember.allowedCountries
salesperson.scopeTokens             <objet>.scopePath
<objet>.countryCode
```

Ce sont des **champs custom créés en métadonnées de workspace**, pas en code. Aucune migration
TypeORM, aucun `standard-field-ids.ts` du fork ne les porte. Ils ne voyagent donc pas avec le
dépôt, et **un workspace neuf sans eux n'est pas cloisonné du tout**.

Le code est volontairement défensif — `isDefined(fieldIdByName[SCOPE_PATH_FIELD])`, no-op de
`CountryCodeFromRelationService` — ce qui veut dire qu'il **ne proteste pas** : il laisse passer.

Les scripts qui peuplent ces champs (`sync_member_scopes.py`, `compute_scope_paths.py`) vivent dans
le dépôt `snetor/client-matrix`, pas ici.

### `NX_DAEMON=false` — une variable qui n'est pas dans ce dépôt non plus

Le 2026-09-14, `nx build twenty-shared` est resté bloqué **11 heures** sur son étape
`generateBarrels` : aucun log écrit, aucun CPU consommé. Un blocage silencieux ressemble à une
lenteur, donc on l'attend au lieu de le diagnostiquer. Le daemon Nx en était la cause, et
`NX_DAEMON=false` le débloque.

La variable est posée dans le `~/.claude/settings.json` du poste, déployé par
`scripts/deploy-claude.ps1` du dépôt `snetor/snetor-ai-guidelines`. **Pas ici, et c'est délibéré :**
le `.claude/settings.json` de ce dépôt est un fichier **amont** — son contenu est identique à
`upstream/main`, et Twenty l'a réécrit 5 fois en 6 mois. Y écrire la variable fabriquerait un point
d'ancrage de plus à recoller à chaque montée, pour une valeur qui ne concerne que nos postes.

Conséquence à connaître : un poste qui n'a jamais lancé `deploy-claude.ps1`, ou un terminal ouvert
hors session Claude Code, **n'a pas la variable**. Si un build se met à ne plus rien écrire pendant
plus de trois minutes, c'est la première chose à vérifier :

```
echo "NX_DAEMON=[$NX_DAEMON]"        # attendu : NX_DAEMON=[false]
NX_DAEMON=false npx nx build twenty-shared --skip-nx-cache
```

---

## 7. La checklist de montée

### Avant

- [ ] Vérifier la généalogie : `git merge-base HEAD twenty/vX.Y.Z` doit rendre un commit de la
      lignée de la version actuelle du fork, **pas** un commit vieux de plusieurs mois. Sinon,
      poser la greffe (§2).
- [ ] **Compter les migrations, pas les conflits.** Le coût d'une montée est là :
      `git diff --name-status twenty/<actuelle> twenty/<cible> -- '**/upgrade-version-command/**'`.
      Repère : entre 2.30 et 2.39, **121 commandes de montée** sur neuf paliers.
- [ ] Prendre une sauvegarde **vérifiée** de la base, et relever un repère PITR.
- [ ] `echo "NX_DAEMON=[$NX_DAEMON]"` doit rendre `[false]`. Sinon, un `nx build` peut rester
      bloqué des heures sans écrire un log (§6).

### Pendant

- [ ] `git merge twenty/vX.Y.Z` — **jamais un rebase**. Un rebase rend la PR `CONFLICTING`, et
      alors aucun workflow `pull_request` ne se déclenche : la CI devient muette au lieu de rouge.
- [ ] Résoudre par risque décroissant : lecture ORM → écriture ORM → groupBy → surfaces système →
      agent → CI → docs.
- [ ] Lancer **les quatre sentinelles avant tout le reste**.
- [ ] Relire à l'œil les quatre points du §5.
- [ ] Vérifier qu'aucun fichier **ajouté** par le fork n'a disparu :
      `git diff --name-only --diff-filter=D twenty/<précédente> HEAD -- \`
      `packages/twenty-server/src/engine/twenty-orm/utils \`
      `packages/twenty-server/src/engine/core-modules/country-scope \`
      `packages/twenty-server/src/engine/core-modules/country-code-derivation`
- [ ] Vérifier les quatre `imports:` de modules NestJS :
      `grep -rn "CountryScopeModule\|CountryCodeDerivationModule" packages/twenty-server/src/engine/core-modules/`
- [ ] Lint et typecheck : `npx nx lint twenty-server`, `npx nx typecheck twenty-server`.
      **oxlint + oxfmt**, pas eslint.

### Ce que la CI rend sur une PR de montée — et qui n'est pas un défaut

Mesuré sur la PR #25 (v2.30.0 → v2.39.0) : **139 verts, 16 rouges**. Aucun des 16 ne venait de
notre code. Les reconnaître fait gagner des heures — et surtout évite de « réparer » ce qui n'est
pas cassé.

**D'abord, la seule chose qui compte vraiment.** Le ruleset ne pose **aucun
`required_status_checks`** : ces rouges ne bloquent pas le merge, seule l'approbation le fait.
C'est donc un jugement humain, pas un feu rouge automatique. Raison de plus pour les trier
sérieusement.

| Rouge | Nature | Quoi faire |
|---|---|---|
| `ci-server-status-check`, `ci-twenty-apps-status-check`, `ci-front-component-renderer-status-check`, `ci-create-app-status-check`, `ci-example-app-postcard-status-check`, `notify-main-ci-failure` | **Agrégateurs.** Ils font `exit 1` dès qu'un job dont ils dépendent échoue | Ne pas les compter comme des causes — chercher le job en amont |
| `server-previous-version-upgrade-mutation-guard` | Interdit de toucher aux commandes de montée des paliers antérieurs. Une PR de merge en apporte forcément : ce sont les commits de l'amont | Vérifier qu'aucun commit Snetor n'en modifie, puis poser le label `ci:allow-previous-version-upgrade-mutation` |
| `discord`, `last-contact`, `people-data-labs`, `server-apps-install-smoke (…)` | Applications publiques ajoutées par l'amont, qui appellent des API tierces avec des clés que le fork n'a pas | Rien. Elles ne seront jamais vertes ici |
| `api-breaking-changes` | Compare les schémas GraphQL et REST entre la base et la PR. Neuf releases d'écart = l'API amont a changé | Rien — c'est le changement de l'amont qu'il signale, pas le nôtre |
| `danger-js` | `The job has exceeded the maximum execution time of 5m0s` — il analyse le diff, ici 9 752 fichiers | Rien. Mécanique sur une PR de merge |
| `renderer-sb-test` | `The job was not started because it repeatedly failed to be acquired (5 attempts)` — le runner GitHub n'a jamais démarré | Relancer si on y tient. C'est de l'infrastructure |
| `server-integration-test (N)` | Instable | Relancer une fois avant de conclure |

⚠️ **Le label ne suffit pas à relancer.** Le workflow lit
`github.event.pull_request.labels.*.name`, c'est-à-dire le **payload de l'événement d'origine**.
`gh run rerun` rejoue l'ancien payload et échouera encore. Il faut **redéclencher** l'événement :
fermer puis rouvrir la PR (`gh pr close` / `gh pr reopen`), ce qui ne coûte rien et ne touche pas
aux commits.

**Ce qu'il faut exiger vert, en revanche** — ce sont eux qui parlent de notre code :

```
server-lint-typecheck        le typecheck complet, dans un environnement propre
server-test (1..N)           les tests unitaires du serveur
check-blocked-contributors   aucun trailer d'attribution IA
```

### Pour la pull request

- [ ] `gh pr create --repo snetor/twenty` — sans `--repo`, la PR vise `twentyhq`. Vérifier ensuite
      `isCrossRepository: false`.
- [ ] **Aucun trailer `Co-Authored-By: Claude`**, aucun pied « Generated with Claude Code » :
      `check-blocked-contributors` rend la CI rouge, y compris sur notre `main`.
- [ ] `gh pr checks` **jamais derrière un pipe** — le pipe avale le code de sortie et affiche vert
      sur du rouge.
- [ ] Le ruleset exige `approvals=1`, et un auteur ne peut pas s'accorder la sienne. Un merge
      refusé ici n'est **pas** une CI rouge : lire `gh api repos/snetor/twenty/rules/branches/main`.
- [ ] **Merger en merge commit, jamais en squash** (§2).

### Pour l'image

- [ ] **`--target twenty` obligatoire.** Sans lui, le Dockerfile multi-étages construit sa dernière
      cible — le tout-en-un de développement — et le CRM tombe.
- [ ] Construire par `az acr build`, jamais en local : Cato intercepte le TLS depuis le réseau
      Snetor. Le streamer de logs meurt sur un `➤` en cp1252 **sans tuer le build** : ne pas
      relancer, suivre par `az acr task list-runs`.
- [ ] Comparer la **taille** de l'image à la précédente avant bascule.

### Après le déploiement

- [ ] **Une montée n'est pas finie quand le job d'init rend `Succeeded`** : `database:init:prod` ne
      traite que l'instance, pas le workspace. Lancer la commande de workspace ciblée dès qu'un
      « missing in object metadata » apparaît.
- [ ] Redémarrer le serveur **puis Redis** — le cache d'entités core survit au redémarrage du
      serveur seul.
- [ ] Vérifier la répartition du trafic : `az containerapp update --image` redonne 100 % du trafic
      à la nouvelle révision, même en mode Multiple.
- [ ] **Recette dans le navigateur, avec un compte de commercial scopé.** Une mesure par clé API ne
      prouve rien : la clé est exemptée du filtre.
