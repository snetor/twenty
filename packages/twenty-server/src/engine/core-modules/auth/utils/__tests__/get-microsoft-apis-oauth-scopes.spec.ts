import { getMicrosoftApisOauthScopes } from 'src/engine/core-modules/auth/utils/get-microsoft-apis-oauth-scopes';

// SPEC-SENTINELLE SNETOR — elle ne défend pas un patch, elle surveille une dépendance HORS DÉPÔT.
//
// Ces scopes ne sont pas qu'une liste de chaînes : ce sont exactement les permissions déléguées
// que l'inscription d'application Entra `app-twenty-dev` doit déclarer, et pour lesquelles un
// consentement administrateur doit exister à l'échelle du tenant Snetor. Entra n'accorde que ce
// qui est déclaré. Un scope demandé ici mais absent là-bas ne casse rien au déploiement — il fait
// tomber l'utilisateur sur « approbation administrateur requise » au moment où il connecte son
// compte Microsoft.
//
// ⚠️ INCIDENT DU 2026-09-18, et il a coûté trois jours de diagnostic.
// La montée en v2.39.0 a ajouté la création d'événements d'agenda côté amont, donc
// `Calendars.ReadWrite` là où cette fonction demandait `Calendars.Read`. L'inscription Entra
// déclarait toujours `Calendars.Read`. Aucun conflit de merge, aucune erreur au démarrage, aucune
// CI rouge : le seul signal a été une commerciale bloquée, et le symptôme s'est présenté comme
// « elle n'a pas accès à Twenty » alors que son compte et son affectation étaient corrects. Les
// personnes ayant connecté leur compte AVANT la montée ne voyaient rien, ce qui a masqué la panne.
//
// SI CETTE SPEC ÉCHOUE APRÈS UN MERGE AMONT, ce n'est pas elle qu'il faut corriger en premier.
// C'est le signal que l'inscription d'application Entra est à mettre à jour AVANT de déployer :
//
//   az ad app permission add --id <appId de app-twenty-dev> \
//     --api 00000003-0000-0000-c000-000000000000 --api-permissions <id du scope>=Scope
//   az ad app permission admin-consent --id <appId de app-twenty-dev>
//
// Puis vérifier le résultat sur les `oauth2PermissionGrants` du service principal — le
// `admin-consent` peut sortir en 0 sans avoir étendu la subvention existante.
//
// Le contexte complet est dans `modules/twenty/main.tf` du dépôt `snetor/azure-landing-zone`,
// au bloc « Sync Microsoft ». L'application n'est pas gérée par Terraform.
describe('getMicrosoftApisOauthScopes — sentinelle de consentement Entra', () => {
  // Épinglé au 2026-09-18, sur twenty/v2.39.0. Toute divergence est un signal, jamais un détail.
  const SCOPES_CONSENTIS_DANS_ENTRA = [
    'openid',
    'email',
    'profile',
    'offline_access',
    'Mail.ReadWrite',
    'Mail.Send',
    'Calendars.ReadWrite',
    'User.Read',
  ];

  it('ne demande aucun scope absent du consentement administrateur Snetor', () => {
    const manquants = getMicrosoftApisOauthScopes().filter(
      (scope) => !SCOPES_CONSENTIS_DANS_ENTRA.includes(scope),
    );

    expect(manquants).toEqual([]);
  });

  it('signale aussi un scope RETIRÉ par l amont', () => {
    // Un scope qui disparaît en amont n'est pas urgent, mais il laisse une permission accordée
    // que plus personne n'utilise. On veut le savoir pour la retirer, pas l'apprendre six mois
    // plus tard dans un audit.
    const devenusInutiles = SCOPES_CONSENTIS_DANS_ENTRA.filter(
      (scope) => !getMicrosoftApisOauthScopes().includes(scope),
    );

    expect(devenusInutiles).toEqual([]);
  });
});
