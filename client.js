/**
 * dsh-mc-compiler — Client half.
 *
 * Registers one sidebar row ("MC compiler") and the matching root-scoped main
 * panel. The panel lists the `.mc` scripts under the configured root, compiles
 * them through the host half, and renders each file's state plus compiler
 * diagnostics. All filesystem and subprocess work stays on the host side.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mc-compiler',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-mc-compiler';
    const PANEL_ID = 'mc-compiler';

    // DOCUMENT-RELATIVE on purpose: the GUI is served with <base href="./">,
    // so a leading slash would escape the app root on a sub-path deployment.
    const LIST_URL = 'api/mc-compiler/list';
    const COMPILE_URL = 'api/mc-compiler/compile';
    const COMPILERS_URL = 'api/mc-compiler/compilers';
    const SELECT_URL = 'api/mc-compiler/select';

    const zh = {
      'entry.label': 'MC 编译',
      'entry.tooltip': '编译 .mc 脚本并查看错误码',
      'panel.title': 'MC 编译',
      'panel.subtitle': '脚本目录',
      'panel.count': '{count} 个文件',
      'panel.refresh': '刷新',
      'panel.compileAll': '编译全部',
      'panel.compiler': '编译器',
      'panel.compilerBundled': '内置',
      'panel.compilerFailed': '这个编译器用不了：{error}',
      'panel.compilerStored': '选择保存在 {path}',
      'panel.compilerSwitching': '正在切换…',
      'panel.compilerSwitched': '已切换',
      'panel.compile': '编译',
      'panel.search': '搜索文件名…',
      'panel.loading': '正在读取目录…',
      'panel.empty': '这个目录里还没有 .mc 文件',
      'panel.emptyHint': '把 .mc 脚本放进下面这个目录：',
      'panel.noMatch': '没有匹配的文件',
      'panel.error': '出错了：{error}',
      'panel.notCompiled': '未编译',
      'panel.module': '模块',
      'panel.source': '源码',
      'panel.truncated': '（已截断）',
      'panel.noErrors': '无错误',
      'panel.errors': '{count} 个错误',
      'state.EXECUTABLE': '可执行',
      'state.DEPENDENCY': '依赖',
      'state.FAILED': '编译失败',
      'state.BLANK': '空白',
      'state.READONLY': '只读',
    };

    const en = {
      'entry.label': 'MC compiler',
      'entry.tooltip': 'Compile .mc scripts and read their diagnostics',
      'panel.title': 'MC compiler',
      'panel.subtitle': 'Script directory',
      'panel.count': '{count} files',
      'panel.refresh': 'Refresh',
      'panel.compileAll': 'Compile all',
      'panel.compiler': 'Compiler',
      'panel.compilerBundled': 'bundled',
      'panel.compilerFailed': 'This compiler cannot run: {error}',
      'panel.compilerStored': 'Choice stored in {path}',
      'panel.compilerSwitching': 'Switching…',
      'panel.compilerSwitched': 'Switched',
      'panel.compile': 'Compile',
      'panel.search': 'Search file name…',
      'panel.loading': 'Reading directory…',
      'panel.empty': 'No .mc files in this directory yet',
      'panel.emptyHint': 'Put your .mc scripts in:',
      'panel.noMatch': 'No matching files',
      'panel.error': 'Failed: {error}',
      'panel.notCompiled': 'not compiled',
      'panel.module': 'Module',
      'panel.source': 'Source',
      'panel.truncated': '(truncated)',
      'panel.noErrors': 'No errors',
      'panel.errors': '{count} errors',
      'state.EXECUTABLE': 'executable',
      'state.DEPENDENCY': 'dependency',
      'state.FAILED': 'failed',
      'state.BLANK': 'blank',
      'state.READONLY': 'read-only',
    };

    /** Replaced by ctx.locale.bind(NS) once the plugin applies. */
    let translate = () => '';

    function t(key, params) {
      let text;
      try {
        text = translate(key);
      } catch {
        text = undefined;
      }
      if (typeof text !== 'string' || text === '') text = key;
      if (!params) return text;
      return text.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match);
    }

    const muted = { opacity: 0.62 };
    const mono = {
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    };

    const STATE_COLORS = {
      EXECUTABLE: '#4cc38a',
      DEPENDENCY: '#8a94a6',
      FAILED: '#e5534b',
      BLANK: '#8a94a6',
      READONLY: '#c69026',
    };

    const styles = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        height: '100%',
        minHeight: 0,
        padding: '18px 20px 16px',
        boxSizing: 'border-box',
        color: 'inherit',
      },
      header: { display: 'flex', alignItems: 'center', gap: 10 },
      title: { margin: 0, fontSize: 15, fontWeight: 600, letterSpacing: 0.2 },
      count: {
        ...muted,
        fontSize: 11,
        padding: '2px 7px',
        borderRadius: 999,
        border: '1px solid rgba(128,128,128,.28)',
      },
      grow: { flex: 1 },
      compiler: { display: 'inline-flex', alignItems: 'center', gap: 6 },
      compilerLabel: { ...muted, fontSize: 11 },
      compilerNote: { ...muted, fontSize: 11, marginRight: 8 },
      select: {
        font: 'inherit',
        fontSize: 12,
        padding: '4px 8px',
        borderRadius: 8,
        border: '1px solid rgba(128,128,128,.28)',
        background: 'transparent',
        color: 'inherit',
        maxWidth: 260,
        cursor: 'pointer',
      },
      ghost: {
        border: '1px solid rgba(128,128,128,.28)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 12,
        padding: '4px 10px',
        borderRadius: 8,
        cursor: 'pointer',
      },
      primary: {
        border: '1px solid rgba(88,166,255,.55)',
        background: 'rgba(88,166,255,.14)',
        color: 'inherit',
        font: 'inherit',
        fontSize: 12,
        padding: '4px 12px',
        borderRadius: 8,
        cursor: 'pointer',
      },
      subtitle: { ...muted, ...mono, fontSize: 10.5, wordBreak: 'break-all' },
      search: {
        width: '100%',
        boxSizing: 'border-box',
        font: 'inherit',
        fontSize: 12.5,
        padding: '7px 10px',
        borderRadius: 9,
        color: 'inherit',
        border: '1px solid rgba(128,128,128,.28)',
        background: 'rgba(128,128,128,.08)',
        outline: 'none',
      },
      list: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        overflowY: 'auto',
        minHeight: 0,
        paddingRight: 2,
      },
      card: {
        display: 'block',
        width: '100%',
        textAlign: 'left',
        font: 'inherit',
        color: 'inherit',
        background: 'rgba(128,128,128,.06)',
        border: '1px solid rgba(128,128,128,.18)',
        borderRadius: 10,
        padding: '9px 11px',
        cursor: 'pointer',
      },
      cardOpen: { borderColor: 'rgba(128,128,128,.34)' },
      nameRow: { display: 'flex', alignItems: 'center', gap: 8 },
      name: { fontSize: 13, fontWeight: 560 },
      badge: {
        fontSize: 10.5,
        padding: '1px 7px',
        borderRadius: 999,
        border: '1px solid currentColor',
        whiteSpace: 'nowrap',
      },
      chip: {
        ...muted,
        fontSize: 10.5,
        padding: '1px 6px',
        borderRadius: 6,
        border: '1px solid rgba(128,128,128,.22)',
        whiteSpace: 'nowrap',
      },
      meta: { ...muted, ...mono, fontSize: 10.5, wordBreak: 'break-all', marginTop: 4 },
      notice: { ...muted, fontSize: 12.5, padding: '10px 2px' },
      error: {
        fontSize: 12,
        color: '#e5534b',
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid rgba(229,83,75,.35)',
        background: 'rgba(229,83,75,.08)',
      },
      diag: {
        ...mono,
        display: 'flex',
        gap: 8,
        fontSize: 11.5,
        padding: '3px 0',
        alignItems: 'baseline',
      },
      code: { color: '#e5534b', fontWeight: 600, minWidth: 34 },
      pos: { ...muted, minWidth: 62 },
      source: {
        ...mono,
        fontSize: 11.5,
        lineHeight: 1.5,
        margin: '8px 0 0',
        padding: '9px 11px',
        borderRadius: 8,
        border: '1px solid rgba(128,128,128,.18)',
        background: 'rgba(0,0,0,.22)',
        maxHeight: 260,
        overflow: 'auto',
        whiteSpace: 'pre',
      },
    };

    /** Load the script list from the host half. */
    function useScripts() {
      const [state, setState] = React.useState({
        status: 'loading',
        root: '',
        files: [],
        error: '',
      });
      const load = React.useCallback(async () => {
        setState((previous) => ({ ...previous, status: 'loading', error: '' }));
        try {
          const response = await fetch(LIST_URL, { cache: 'no-store', headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const data = await response.json();
          setState({
            status: 'ready',
            root: String(data.root || ''),
            files: Array.isArray(data.files) ? data.files : [],
            error: '',
          });
        } catch (error) {
          setState((previous) => ({
            ...previous,
            status: 'error',
            error: String((error && error.message) || error),
          }));
        }
      }, []);
      React.useEffect(() => {
        load();
      }, [load]);
      return { ...state, reload: load };
    }

    /** The jars the host found, plus the ability to switch between them. */
    function useCompilers() {
      const [state, setState] = React.useState({ items: [], selected: '', error: '' });
      const load = React.useCallback(async () => {
        try {
          const response = await fetch(COMPILERS_URL, { cache: 'no-store', headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const data = await response.json();
          setState({
            items: Array.isArray(data.items) ? data.items : [],
            selected: String(data.selected || ''),
            error: '',
          });
        } catch (error) {
          setState({ items: [], selected: '', error: String((error && error.message) || error) });
        }
      }, []);
      React.useEffect(() => {
        load();
      }, [load]);

      const choose = React.useCallback(
        async (jar) => {
          try {
            const response = await fetch(SELECT_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ jar }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status);
            setState((previous) => ({ ...previous, selected: String(data.selected || ''), error: '' }));
            return { ok: true };
          } catch (error) {
            setState((previous) => ({ ...previous, error: String((error && error.message) || error) }));
            return { ok: false, error: String((error && error.message) || error) };
          }
        },
        [],
      );

      return { ...state, reload: load, choose };
    }

    /** Compile a set of files (or everything) and merge the results by path. */
    function useCompiler() {
      const [results, setResults] = React.useState({});
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');

      const compile = React.useCallback(async (request) => {
        setBusy(true);
        setError('');
        try {
          const response = await fetch(COMPILE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(request),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status);
          const next = {};
          for (const item of Array.isArray(data.results) ? data.results : []) {
            next[item.file] = item;
          }
          setResults((previous) => ({ ...previous, ...next }));
          return next;
        } catch (failure) {
          setError(String((failure && failure.message) || failure));
          return null;
        } finally {
          setBusy(false);
        }
      }, []);

      return { results, busy, error, compile };
    }

    /** Localized state label, falling back to the raw enum name. */
    function stateName(state) {
      const key = 'state.' + state;
      const label = t(key);
      return label === key ? state : label;
    }

    function StateBadge({ state }) {
      const color = STATE_COLORS[state] || '#8a94a6';
      return h('span', { style: { ...styles.badge, color } }, stateName(state));
    }

    function FileRow({ file, result, open, onToggle, onCompile }) {
      const errors = result && Array.isArray(result.errors) ? result.errors : [];
      const state = result ? result.state : '';
      return h(
        'div',
        null,
        h(
          'button',
          {
            type: 'button',
            onClick: onToggle,
            title: file.path,
            style: open ? { ...styles.card, ...styles.cardOpen } : styles.card,
          },
          h(
            'div',
            { style: styles.nameRow },
            h('span', { style: { ...muted, fontSize: 11 } }, open ? '▾' : '▸'),
            h('span', { style: styles.name }, file.name),
            state ? h(StateBadge, { state }) : h('span', { style: styles.chip }, t('panel.notCompiled')),
            errors.length > 0 ? h('span', { style: styles.chip }, t('panel.errors', { count: errors.length })) : null,
            h('span', { style: styles.grow }),
            result && result.module
              ? h('span', { style: styles.chip }, t('panel.module') + ' ' + result.module)
              : null,
          ),
          h('div', { style: styles.meta }, file.rel),
        ),
        open
          ? h(
              'div',
              { style: { marginTop: 6 } },
              h(
                'div',
                { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: (event) => {
                      event.stopPropagation();
                      onCompile(file.path);
                    },
                    style: styles.primary,
                  },
                  t('panel.compile'),
                ),
                h(
                  'span',
                  { style: { ...muted, fontSize: 10.5 } },
                  result ? stateName(state) : t('panel.notCompiled'),
                ),
              ),
              h(
                'div',
                { style: { marginTop: 8 } },
                errors.length === 0
                  ? h('div', { style: styles.meta }, result ? t('panel.noErrors') : '')
                  : errors.map((error, index) =>
                      h(
                        'div',
                        { key: index, style: styles.diag },
                        h('span', { style: styles.code }, error.code),
                        h('span', { style: styles.pos }, `${error.line}:${error.col}`),
                        h('span', null, error.message),
                      )),
              ),
              h('div', { style: { ...styles.meta, marginTop: 10 } }, t('panel.source')),
              h(
                'pre',
                { style: styles.source },
                file.content
                  ? file.content + (file.truncated ? '\n' + t('panel.truncated') : '')
                  : file.readError || '',
              ),
            )
          : null,
      );
    }

    /** "name (bundled) · commit" — enough to tell two jars apart. */
    function shortenPath(value) {
      const text = String(value || '');
      const sep = text.includes('\\') ? '\\' : '/';
      const parts = text.split(/[\\/]+/).filter(Boolean);
      return parts.length <= 3 ? text : `…${sep}${parts.slice(-3).join(sep)}`;
    }

    function jarLabel(item, t) {
      const version = item.known ? item.commit : '?';
      const suffix = item.role === 'bundled' ? ` (${t('panel.compilerBundled')})` : '';
      return `${item.name}${suffix} · ${version}`;
    }

    function PanelPage() {
      const list = useScripts();
      const compiler = useCompiler();
      const compilers = useCompilers();

      // A controlled `value` on a <select> is applied before its options are
      // mounted, so the browser would fall back to the first option. Assign the
      // value after the commit instead.
      const selectRef = React.useRef(null);
      const wanted = compilers.selected !== '' ? compilers.selected : (compilers.items[0] && compilers.items[0].path) || '';
      React.useEffect(() => {
        const node = selectRef.current;
        if (node !== null && node.value !== wanted) node.value = wanted;
      }, [wanted, compilers.items.length]);
      const [query, setQuery] = React.useState('');
      const [switchNote, setSwitchNote] = React.useState('');
      const [openPath, setOpenPath] = React.useState(null);

      const visible = React.useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (needle === '') return list.files;
        return list.files.filter((file) =>
          (file.name + ' ' + file.rel).toLowerCase().includes(needle));
      }, [list.files, query]);

      let body;
      if (list.status === 'loading' && list.files.length === 0) {
        body = h('div', { style: styles.notice }, t('panel.loading'));
      } else if (list.status === 'error') {
        body = h(
          'div',
          null,
          h('div', { style: styles.error }, t('panel.error', { error: list.error })),
          h(
            'button',
            { type: 'button', onClick: list.reload, style: { ...styles.ghost, marginTop: 8 } },
            t('panel.refresh'),
          ),
        );
      } else if (list.files.length === 0) {
        body = h(
          'div',
          { style: styles.notice },
          h('div', null, t('panel.empty')),
          h('div', { style: { ...styles.meta, marginTop: 6 } }, t('panel.emptyHint')),
          h('div', { style: { ...styles.subtitle, marginTop: 4 } }, list.root),
        );
      } else if (visible.length === 0) {
        body = h('div', { style: styles.notice }, t('panel.noMatch'));
      } else {
        body = visible.map((file) =>
          h(FileRow, {
            key: file.path,
            file,
            result: compiler.results[file.path],
            open: openPath === file.path,
            onToggle: () => setOpenPath(openPath === file.path ? null : file.path),
            onCompile: (target) => compiler.compile({ paths: [target] }),
          }));
      }

      return h(
        'div',
        { style: styles.page },
        h(
          'div',
          { style: styles.header },
          h('h2', { style: styles.title }, t('panel.title')),
          h('span', { style: styles.count }, t('panel.count', { count: list.files.length })),
          h('span', { style: styles.grow }),
          switchNote === ''
            ? null
            : h('span', { style: styles.compilerNote }, switchNote),
          h(
            'label',
            { style: styles.compiler },
            h('span', { style: styles.compilerLabel }, t('panel.compiler')),
            h(
              'select',
              {
                ref: selectRef,
                onChange: async (event) => {
                  const wanted = event.target.value;
                  setSwitchNote(t('panel.compilerSwitching'));
                  const outcome = await compilers.choose(wanted);
                  if (!outcome.ok) {
                    setSwitchNote('');
                    return;
                  }
                  await list.reload();
                  await compiler.compile({ all: true });
                  setSwitchNote(t('panel.compilerSwitched'));
                },
                style: styles.select,
                // Hovering names the file the display mirrors, so the panel and
                // the profile contents never disagree.
                title: compilers.selection
                  ? t('panel.compilerStored', { path: compilers.selection })
                  : t('panel.compiler'),
                disabled: compilers.items.length < 2,
              },
              compilers.items.map((item) =>
                h('option', { key: item.path, value: item.path }, jarLabel(item, t)),
              ),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: () => compiler.compile({ all: true }),
              disabled: compiler.busy || list.files.length === 0,
              style: styles.primary,
            },
            compiler.busy ? '…' : t('panel.compileAll'),
          ),
          h(
            'button',
            { type: 'button', onClick: list.reload, style: styles.ghost, title: t('panel.refresh') },
            t('panel.refresh'),
          ),
        ),
        h('div', { style: styles.subtitle }, t('panel.subtitle') + ': ' + list.root),
        compiler.error
          ? h('div', { style: styles.error }, t('panel.error', { error: compiler.error }))
          : null,
        h('input', {
          type: 'search',
          value: query,
          placeholder: t('panel.search'),
          onChange: (event) => setQuery(event.target.value),
          style: styles.search,
        }),
        h('div', { style: styles.list }, body),
      );
    }

    /** Sidebar rail icon: a terminal prompt under a chevron pair. */
    function PanelIcon(props) {
      const size = (props && props.size) || 18;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v10A1.5 1.5 0 0 1 20 18.5H4A1.5 1.5 0 0 1 2.5 17V7A1.5 1.5 0 0 1 4 5.5z' }),
        h('path', { d: 'M6.5 10l2.2 2.2-2.2 2.2' }),
        h('path', { d: 'M11.5 14.6h5' }),
      );
    }

    /** Services the panel cannot mount without. */
    const inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mc-compiler: dictionaries');
      try {
        translate = ctx.locale.bind(NS);
      } catch {
        translate = (key) => key;
      }

      const disposers = [];
      disposers.push(
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 31,
              label: () => t('entry.label'),
              locale: NS,
            },
            PanelIcon,
          )),
      );
      disposers.push(
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS,
            },
            PanelPage,
          )),
      );
      ctx.effect(
        () => () => {
          for (const dispose of disposers.splice(0)) dispose();
        },
        'mc-compiler: slots',
      );
    }

    // The loader calls the factory with `require` only: there is no `module`
    // or `exports` binding in scope, so return the plugin exports directly.
    return { apply, inject };
  },
});
