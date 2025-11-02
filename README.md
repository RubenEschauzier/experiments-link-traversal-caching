# My Experiment

This experiment was created with [jbr](https://github.com/rubensworks/jbr.js).

## Requirements

* [Node.js](https://nodejs.org/en/) _(1.12 or higher)_

## Installation

Before this experiment can be used, its dependencies must be downloaded first:

```bash
$ npm install
```
## Post Installation Commands

As the experiment code is undergoing review and refactoring before merging with the main code base, this experiment uses packages with different namespaces. Due to complexities with components.js and npm some slight adjustments to the node_modules must be made:

```bash
mkdir node_modules/@rubeneschauzier
cp -r node_modules/@jbr-experiment/solidbench-sequence node_modules/@rubeneschauzier
cp -r node_modules/sparql-query-parameter-instantiator node_modules/@rubeneschauzier
cp -r node_modules/rdf-dataset-fragmenter node_modules/@rubeneschauzier
cp -r node_modules/ldbc-snb-enhancer node_modules/@rubeneschauzier
cp -r node_modules/ldbc-snb-validation-generator node_modules/@rubeneschauzier


```
## Usage

Generate the dataset and queries:

```bash
$ npm run jbr -- prepare
```

Run the experiment locally:

```bash
$ npm run jbr -- run
```

The `output/` directory will now contain all experiment results.

## Usage if jbr is installed globally

If [jbr is installed globally](https://github.com/rubensworks/jbr.js/tree/master/packages/jbr#installation),
you can prepare and run this experiment as follows:

```bash
$ jbr prepare
$ jbr run
```
