# ChatGPT Image Batch Automator

Extension Chrome permettant d'envoyer automatiquement plusieurs prompts a ChatGPT, d'attendre la generation des images, puis de les telecharger avec le nom de leur cle JSON.

## Fonctionnalites

- Envoi automatique d'une liste de prompts JSON.
- Attente de la generation complete de chaque image.
- Telechargement automatique des images.
- Nommage selon les cles JSON : `01.png`, `02.png`, `03.png`.
- Gestion de plusieurs images pour un meme prompt : `01a.png`, `01b.png`, `01c.png`.
- Intervalle configurable entre les prompts.
- Compteur visible avant l'envoi du prompt suivant.
- Mode fiable pour conserver l'onglet ChatGPT actif.
- Prefixe global optionnel ajoute a chaque prompt.
- Journal d'execution pour suivre les etapes et diagnostiquer les erreurs.
- Valeur speciale `"text"` pour ignorer une scene sans generer d'image.

## Installation

1. Telechargez le depot avec le bouton **Code > Download ZIP**.
2. Extrayez le fichier ZIP.
3. Ouvrez Chrome et accedez a `chrome://extensions`.
4. Activez le **Mode developpeur**.
5. Cliquez sur **Charger l'extension non empaquetee**.
6. Selectionnez le dossier contenant le fichier `manifest.json`.

## Utilisation

1. Ouvrez [ChatGPT](https://chatgpt.com/) et connectez-vous.
2. Ouvrez l'extension depuis la barre laterale Chrome.
3. Collez vos prompts au format JSON.
4. Verifiez le dossier d'enregistrement.
5. Configurez l'intervalle minimum et maximum.
6. Activez eventuellement le mode fiable.
7. Cliquez sur **Start**.

L'extension traite les prompts dans l'ordre numerique de leurs cles.

## Format JSON

```json
{
  "01": "Generate the first image. Format 16:9.",
  "02": "Generate the second image. Format 16:9.",
  "03": "Generate the third image. Format 16:9."
}
```

Les cles servent de nom aux fichiers telecharges : `01.png`, `02.png` et `03.png`.

Pour ignorer une scene, utilisez la valeur `"text"` :

```json
{
  "08": "Generate scene eight.",
  "09": "text",
  "10": "Generate scene ten."
}
```

L'extension genere `08.png`, ignore completement `09`, puis genere `10.png`. Les variantes `" text "` et `"TEXT"` sont egalement ignorees.

## Prefixe global

Le champ **Prefixe global** permet d'ajouter automatiquement des instructions communes au debut de chaque prompt : style graphique, personnages, couleurs, typographie et composition.

Lorsque l'option est activee, le prompt envoye a ChatGPT est construit ainsi :

```text
[Prefixe global]

SCENE TO ILLUSTRATE:

[Prompt de la scene]
```

Desactivez l'option si vos prompts sont deja complets.

## Dossier d'enregistrement

Par defaut, les images sont enregistrees dans `Downloads/ChatGPT_images/`. Le dossier peut etre modifie depuis l'extension.

Chrome autorise automatiquement les sous-dossiers du dossier Downloads, par exemple :

```text
C:\Users\VotreNom\Downloads\ChatGPT_images
```

L'extension verifie le dossier et le nommage avant de commencer la generation.

## Intervalle entre les prompts

Les champs **Min** et **Max** definissent un delai aleatoire entre deux prompts.

Exemple : `Min : 5`, `Max : 15` choisit aleatoirement un delai compris entre 5 et 15 secondes.

Pour supprimer l'attente : `Min : 0`, `Max : 0`.

## Mode fiable

Le mode fiable est recommande pour les longues generations ou lorsque ChatGPT doit rester actif dans Chrome. Il garde l'onglet ChatGPT actif et verifie regulierement qu'il est toujours disponible.

Pour une utilisation normale, ce mode peut rester desactive.

## Journal d'execution

Le **Journal d'execution** affiche les principales etapes : demarrage, verification du dossier, prompt envoye, image detectee, telechargement termine et erreurs eventuelles.

Les boutons **Copier** et **Effacer** permettent de gerer le journal.

## Arret et limites

Cliquez sur **Stop** pour demander l'arret de la file.

La generation depend des limites, erreurs et temps de reponse de ChatGPT. L'interface de ChatGPT peut evoluer et necessiter une mise a jour de l'extension. Les references visuelles doivent etre presentes dans la conversation ChatGPT utilisee.

L'extension automatise l'interface de ChatGPT. Elle ne fournit pas de compte ChatGPT et n'utilise pas l'API OpenAI.

## Developpement

Les tests peuvent etre lances avec :

```text
node --test tests/background.test.mjs tests/content-script.test.mjs
```
