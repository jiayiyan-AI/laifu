import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';

test('loads package extensions and skills supplied only to the runtime loader', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-resource-loader-'));
  try {
    const packageRoot = join(root, 'extension');
    const skillsRoot = join(root, 'skills');
    await Promise.all([mkdir(packageRoot), mkdir(join(skillsRoot, 'example'), { recursive: true })]);
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ pi: { extensions: ['./index.ts'] } }));
    await writeFile(join(packageRoot, 'index.ts'), 'export default () => {};\n');
    await writeFile(join(skillsRoot, 'example', 'SKILL.md'), '---\nname: example\ndescription: runtime skill\n---\n# Example\n');

    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: getAgentDir(),
      settingsManager: SettingsManager.inMemory(),
      additionalExtensionPaths: [packageRoot],
      additionalSkillPaths: [skillsRoot],
    });
    await loader.reload();

    expect(loader.getExtensions().extensions.map((extension) => extension.resolvedPath)).toContain(join(packageRoot, 'index.ts'));
    expect(loader.getSkills().skills.map((skill) => skill.name)).toContain('example');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
