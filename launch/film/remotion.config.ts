import {Config} from '@remotion/cli/config';
Config.setPublicDir('../dist');
Config.setVideoImageFormat('jpeg');
Config.setJpegQuality(95);
Config.setConcurrency(2);
Config.setOverwriteOutput(true);
