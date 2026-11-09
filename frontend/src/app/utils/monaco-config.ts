/**
 * Monaco Editor Configuration
 *
 * Configures @monaco-editor/loader to use the webpack-bundled Monaco instance
 * instead of loading from CDN.
 *
 * This must be imported BEFORE any component that uses PatternFly's CodeEditor.
 *
 * How it works:
 * 1. MonacoWebpackPlugin bundles monaco-editor and creates worker files
 * 2. We import the monaco API (which gets processed by the plugin)
 * 3. We pass this instance to @monaco-editor/loader
 * 4. PatternFly CodeEditor (via @monaco-editor/react) uses our bundled instance
 *
 * @see https://github.com/suren-atoyan/monaco-loader#configure-the-loader-to-load-the-monaco-as-an-npm-package
 */
import loader from '@monaco-editor/loader';
import * as monaco from 'monaco-editor';

// Configure the loader to use our webpack-bundled Monaco instance
// This prevents the loader from attempting to load Monaco from CDN
loader.config({ monaco });

export default loader;
