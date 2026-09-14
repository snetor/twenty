# La carte du fork Snetor

Ce fichier existe pour une seule raison : **rendre la prochaine montée de version mécanique au lieu
qu'elle soit archéologique.** Il dit ce que Snetor a ajouté à Twenty, où exactement chaque
modification s'accroche au code amont, et ce qui casse quand l'amont bouge.

Il se met à jour **dans la même pull request** que la modification qu'il décrit. Un fichier de
carte en retard est pire qu'absent : il fait chercher au mauvais endroit.

> **État décrit** : fork sur `twenty/v2.30.0`, 22 commits Snetor, 49 fichiers,
> +5 542 / −48 lignes. Mesure : `git diff --stat twenty/v2.30.0 origin/main`.

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

**Patchs dans du code amont** — les points fragiles :

| Fichier | Point d'ancrage | Fragilité |
|---|---|---|
| `twenty-orm/repository/workspace-select-query-builder.ts` | 1 ligne dans `validatePermissions()`, juste après `applyRowLevelPermissionPredicatesToMainAliasAndJoinedRelations()` | 🔴 corps de méthode privée |
| `twenty-orm/repository/workspace-update-query-builder.ts` | **2** appels : dans `execute()` et dans la boucle `for (const input of this.manyInputs)` | 🔴 dont un dans une boucle |
| `twenty-orm/repository/workspace-delete-query-builder.ts` | 1 appel dans `execute()` | 🔴 |
| `twenty-orm/repository/workspace-soft-delete-query-builder.ts` | 1 appel dans `execute()` | 🔴 |
| `graphql-query-runner/group-by/services/group-by-with-records.service.ts` | 1 ligne dans `addPartitionByToQueryBuilder`, qui doit précéder `subQuery.getQuery()` | 🔴 **le plus fragile** : dépend d'un ordre d'exécution |

⚠️ **Écart connu, présent depuis la 2.30** : le filtre ne porte que sur l'**alias principal**, alors
que l'amont applique aussi ses prédicats aux relations jointes. À réévaluer à chaque montée.

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

### Chantier 3 — Visibilité de la messagerie par défaut

**But métier** : un compte email ou agenda connecté depuis Settings → Accounts ne partage par
défaut que les **métadonnées**, pas le corps des mails, à l'ensemble du workspace.

**Patchs amont** : deux littéraux, dans
`core-modules/auth/services/create-message-channel.service.ts` et
`create-calendar-channel.service.ts` — `SHARE_EVERYTHING` remplacé par `METADATA`.

⚠️ **C'est une modification de valeur, pas une insertion.** Git résout souvent ce type de conflit
« en faveur de l'amont » sans même poser de marqueur. Une régression ici repartage silencieusement
le corps des mails de tous les commerciaux. D'où deux specs-sentinelles pour cinq lignes de patch.

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
| `core-modules/calendar/timeline-calendar-event.service.ts` | idem + substitutions dans `count()`, `find()` et 3 `relatedPersonIds` | 🔴 idem |
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

## 4. Les cinq specs-sentinelles

Ce sont des tests écrits pour **échouer si un merge fait sauter un patch**. Ils ne testent pas une
fonctionnalité : ils testent que l'accroche existe encore. **Ils se lancent avant tout le reste
après un merge.**

| Spec | Ce qu'elle défend | Cas |
|---|---|---|
| `twenty-orm/repository/__tests__/workspace-select-query-builder-country-filter.spec.ts` | le filtre de lecture est bien appelé | 3 |
| `twenty-orm/repository/__tests__/workspace-mutation-query-builders-country-filter.spec.ts` | les trois chemins d'écriture sont filtrés | 2 |
| `group-by/services/__tests__/group-by-with-records-country-filter.spec.ts` | le filtre précède la sérialisation de la sous-requête — `expect(order).toEqual(['scope','getQuery'])` | 2 |
| `auth/services/create-message-channel.service.spec.ts` | le défaut de visibilité reste `METADATA` | 3 |
| `auth/services/create-calendar-channel.service.spec.ts` | idem pour l'agenda | 2 |

Si l'une échoue après un merge : **un patch a sauté. Ne pas continuer, ne pas la réparer en
ajustant l'attente.** Retrouver où l'accroche a disparu.

### L'inventaire complet des tests du fork — 150 cas, 14 fichiers

```
apply-country-permission-filter.util.spec.ts     34
resolve-country-scope.util.spec.ts               31
scope-path-on-create.listener.spec.ts            23
country-scope.service.spec.ts                    17
derive-country-code.util.spec.ts                 11
scope-assignment.listener.spec.ts                 7
navigate-app-tool.spec.ts                         7
country-code-from-relation.service.spec.ts        5
create-message-channel.service.spec.ts            3
get-messages.service.spec.ts                      3
workspace-select-query-builder-country-filter     3
create-calendar-channel.service.spec.ts           2
workspace-mutation-query-builders-country-filter  2
group-by-with-records-country-filter              2
```

---

## 5. Ce qu'aucun test ne rattrapera

Trois choses qu'un humain doit relire à l'œil après chaque montée :

1. **Les substitutions `personIds` → `personIdsInScope`** — 6 occurrences sur deux services. Un
   merge peut en perdre une seule, sans signal.
2. **Les renommages dans `navigate-app-tool.ts`** — `selectColumns` → `baseSelectColumns`,
   `records` → `allRecords`. Si les champs de portée quittent le `select`, le filtre laisse tout
   passer en silence.
3. **La résurrection de `external-contributor-pr-auto-draft.yaml`.**

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

### Pendant

- [ ] `git merge twenty/vX.Y.Z` — **jamais un rebase**. Un rebase rend la PR `CONFLICTING`, et
      alors aucun workflow `pull_request` ne se déclenche : la CI devient muette au lieu de rouge.
- [ ] Résoudre par risque décroissant : lecture ORM → écriture ORM → groupBy → surfaces système →
      agent → CI → docs.
- [ ] Lancer **les cinq sentinelles avant tout le reste**.
- [ ] Relire à l'œil les trois points du §5.
- [ ] Vérifier les quatre `imports:` de modules NestJS :
      `grep -rn "CountryScopeModule\|CountryCodeDerivationModule" packages/twenty-server/src/engine/core-modules/`
- [ ] Lint et typecheck : `npx nx lint twenty-server`, `npx nx typecheck twenty-server`.
      **oxlint + oxfmt**, pas eslint.

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
