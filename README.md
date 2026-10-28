# ChatGPT Image Batch Automator

Extension Chrome permettant d'envoyer automatiquement plusieurs prompts à ChatGPT, d'attendre la génération des images, puis de les télécharger avec le nom de leur clé JSON.

## Fonctionnalités

- Envoi automatique d'une liste de prompts JSON.
- Attente de la génération complète de chaque image.
- Téléchargement automatique des images.
- Nommage selon les clés JSON : `01.png`, `02.png`, `03.png`.
- Gestion de plusieurs images pour un meme prompt : `01a.png`, `01b.png`, `01c.png`.
- Intervalle configurable entre les prompts.
- Compteur visible avant l'envoi du prompt suivant.
- Mode fiable pour conserver l'onglet ChatGPT actif.
- Préfixe global optionnel ajouté à chaque prompt.
- Journal d'exécution pour suivre les étapes et diagnostiquer les erreurs.
- Valeur spéciale `"text"` pour ignorer une scène sans générer d'image.

## Installation

1. Téléchargez le dépôt avec le bouton **Code > Download ZIP**.
2. Décompressez l'archive ZIP.
3. Ouvrez Chrome et accédez à `chrome://extensions`.
4. Activez le **Mode développeur**.
5. Cliquez sur **Charger l'extension non empaquetée**.
6. Sélectionnez le dossier contenant le fichier `manifest.json`.

## Utilisation

1. Ouvrez [ChatGPT](https://chatgpt.com/) et connectez-vous.
2. Ouvrez l'extension depuis la barre latérale Chrome.
3. Collez vos prompts au format JSON.
4. Vérifiez le dossier d'enregistrement.
5. Configurez l'intervalle minimum et maximum.
6. Activez éventuellement le mode fiable.
7. Cliquez sur **Start**.

L'extension traite les prompts dans l'ordre numérique de leurs clés.

## Format JSON

```json
{
  "01": "Generate the first image. Format 16:9.",
  "02": "Generate the second image. Format 16:9.",
  "03": "Generate the third image. Format 16:9."
}
```

Les clés servent de nom aux fichiers téléchargés : `01.png`, `02.png` et `03.png`.

Pour ignorer une scene, utilisez la valeur `"text"` :

```json
{
  "08": "Generate scene eight.",
  "09": "text",
  "10": "Generate scene ten."
}
```

L'extension génère `08.png`, ignore complètement `09`, puis génère `10.png`. Les variantes `" text "` et `"TEXT"` sont également ignorées.

## Préfixe global

Le champ **Préfixe global** permet d'ajouter automatiquement des instructions communes au début de chaque prompt : style graphique, personnages, couleurs, typographie et composition.

Lorsque l'option est activee, le prompt envoye a ChatGPT est construit ainsi :

```text
[Prefixe global]

SCENE TO ILLUSTRATE:

[Prompt de la scene]
```

Désactivez l'option si vos prompts sont déjà complets.

## Dossier d'enregistrement

Par défaut, les images sont enregistrées dans `Downloads/ChatGPT_images/`. Le dossier peut être modifié depuis l'extension.

Chrome autorise automatiquement les sous-dossiers du dossier Downloads, par exemple :

```text
C:\Users\VotreNom\Downloads\ChatGPT_images
```

L'extension vérifie le dossier et le nommage avant de commencer la génération.

## Intervalle entre les prompts

Les champs **Min** et **Max** définissent un délai aléatoire entre deux prompts.

Exemple : `Min : 5`, `Max : 15` choisit aleatoirement un delai compris entre 5 et 15 secondes.

Pour supprimer l'attente : `Min : 0`, `Max : 0`.

## Mode fiable

Le mode fiable est recommandé pour les longues générations ou lorsque ChatGPT doit rester actif dans Chrome. Il garde l'onglet ChatGPT actif et vérifie régulièrement qu'il est toujours disponible.

Pour une utilisation normale, ce mode peut rester desactive.

## Journal d'execution

Le **Journal d'exécution** affiche les principales étapes : démarrage, vérification du dossier, prompt envoyé, image détectée, téléchargement terminé et erreurs éventuelles.

Les boutons **Copier** et **Effacer** permettent de gérer le journal.

## Arrêt et limites

Cliquez sur **Stop** pour demander l'arrêt de la file.

La génération dépend des limites, erreurs et temps de réponse de ChatGPT. L'interface de ChatGPT peut évoluer et nécessiter une mise à jour de l'extension. Les références visuelles doivent être présentes dans la conversation ChatGPT utilisée.

L'extension automatise l'interface de ChatGPT. Elle ne fournit pas de compte ChatGPT et n'utilise pas l'API OpenAI.

## Developpement

Les tests peuvent etre lances avec :

```text
node --test tests/background.test.mjs tests/content-script.test.mjs
```

