// At the fixture root on purpose. "**/" means zero or more directories, so a
// pattern of "**/*.jsx" has to reach this file as well as the nested ones.
// A naive "**" translated to ".*" still matches everything nested and quietly
// stops matching here, which is a difference no nested fixture can show.
export const Root = () => <span className="card">root</span>;
