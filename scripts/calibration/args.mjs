import { defaultLabelsPath } from './paths.mjs';

const takeValue = (args, index, flag) => {
  const inline = args[index].startsWith(`${flag}=`) ? args[index].slice(flag.length + 1) : null;
  return inline ?? args[index + 1] ?? null;
};

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    dryRun: false,
    promote: false,
    validate: false,
    labelsFile: null,
    targetCount: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--promote') options.promote = true;
    else if (arg === '--validate') options.validate = true;
    else if (arg === '--labels-file' || arg.startsWith('--labels-file=')) {
      options.labelsFile = takeValue(argv, index, '--labels-file');
      if (arg === '--labels-file') index += 1;
    } else if (arg === '--target' || arg.startsWith('--target=')) {
      options.targetCount = Number(takeValue(argv, index, '--target'));
      if (arg === '--target') index += 1;
    } else if (arg.startsWith('--target=')) {
      options.targetCount = Number(arg.slice('--target='.length));
    } else if (!arg.startsWith('--') && !options.labelsFile) {
      options.labelsFile = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.promote && options.dryRun) {
    throw new Error('--promote and --dry-run cannot be used together.');
  }
  options.labelsFile ||= defaultLabelsPath;
  return options;
}
