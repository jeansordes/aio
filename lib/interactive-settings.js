const { validName, saveProfiles } = require('./model-profiles');
const { available } = require('./harnesses');
async function modelEntry(terminal, loaded, env, previous) {
  const harness = await terminal.choose('Choose a CLI harness', Object.entries(loaded.harnesses).map(([id, value]) => ({
    label: `${id}${available(value, env) ? '' : ' (not installed — usable as a future fallback)'}`, value: id,
  })));
  if (!harness) return null;
  const model = await terminal.ask('Model identifier accepted by this CLI (required)', previous?.model ?? '');
  if (!model) return null;
  return { harness, model };
}
async function setupProfiles(terminal, profiles, loaded, env) {
  for (const [name, hint] of [['low','lightweight — Luna / Haiku'],['mid','general work — Sol / Sonnet'],['high','demanding work — Astra / Opus']]) {
    if (profiles.profiles[name]) continue;
    await terminal.message(`Set up ${name}`, `Choose a CLI and its actual model identifier for ${hint}.\nThese family names are hints, not identifiers supplied by aio.`);
    const entry = await modelEntry(terminal, loaded, env);
    if (!entry) return false;
    profiles.profiles[name] = [entry]; saveProfiles(profiles);
  }
  return true;
}
async function editProfiles(terminal, profiles, loaded, env) {
  for (;;) {
    const selected = await terminal.choose('Model profiles · ordered fallback lists', [
      ...Object.keys(profiles.profiles).map(name => ({ label: name, value: name })),
      null, { label: 'Create profile', value: '+' }, { label: 'Back', value: '<' },
    ]);
    if (!selected || selected === '<') return;
    let name = selected;
    if (name === '+') {
      name = await terminal.ask('New profile name');
      if (!name) continue;
      if (!validName(name) || Object.hasOwn(profiles.profiles, name)) { await terminal.message('Invalid name', 'Use a unique name with letters, digits, underscores or dashes.'); continue; }
      const entry = await modelEntry(terminal, loaded, env);
      if (!entry) continue;
      profiles.profiles[name] = [entry]; saveProfiles(profiles);
    }
    for (;;) {
      const entries = profiles.profiles[name];
      const choice = await terminal.choose(`Profile: ${name}`, [
        ...entries.map((v,i) => ({ label: `${i+1}. ${v.harness} / ${v.model}`, value:i })), null,
        { label:'Add fallback',value:'add' }, { label:'Rename profile',value:'rename' },
        { label:'Delete profile',value:'delete' }, { label:'Back',value:'back' },
      ]);
      if (choice === null || choice === 'back') break;
      if (choice === 'add') {
        const entry = await modelEntry(terminal, loaded, env);
        if (entry) { entries.push(entry); saveProfiles(profiles); }
      } else if (choice === 'rename') {
        const renamed = await terminal.ask('New name (workflow references must be updated separately)', name);
        if (!renamed || renamed === name) continue;
        if (!validName(renamed) || Object.hasOwn(profiles.profiles, renamed)) { await terminal.message('Invalid name','Choose a unique profile name.'); continue; }
        profiles.profiles[renamed] = entries; delete profiles.profiles[name]; name = renamed; saveProfiles(profiles);
      } else if (choice === 'delete') {
        const confirm = await terminal.choose(`Delete ${name}? Workflows referencing it will need another profile.`, [{label:'Keep profile',value:false},{label:'Delete profile',value:true}]);
        if (confirm) { delete profiles.profiles[name]; saveProfiles(profiles); break; }
      } else {
        const edit = await terminal.choose(`Entry ${choice+1}: ${entries[choice].harness} / ${entries[choice].model}`, [
          {label:'Change CLI / model',value:'edit'}, {label:'Move up',value:'up'}, {label:'Move down',value:'down'},
          ...(entries.length > 1 ? [{label:'Remove entry',value:'remove'}] : []), {label:'Back',value:'back'},
        ]);
        if (edit === 'edit') { const value = await modelEntry(terminal, loaded, env, entries[choice]); if (value) entries[choice] = value; }
        if (edit === 'up' && choice > 0) [entries[choice-1],entries[choice]] = [entries[choice],entries[choice-1]];
        if (edit === 'down' && choice < entries.length-1) [entries[choice+1],entries[choice]] = [entries[choice],entries[choice+1]];
        if (edit === 'remove') entries.splice(choice,1);
        if (edit && edit !== 'back') saveProfiles(profiles);
      }
    }
  }
}
async function collectCriteria(terminal) {
  const criteria = [];
  for (;;) {
    const action = await terminal.choose('Success criteria · choose Finish when the list is complete', [
      ...criteria.map((value,i)=>({label:`${i+1}. ${value}`,value:i})), null,
      {label:'Add criterion',value:'add'}, ...(criteria.length ? [{label:'Finish criteria',value:'finish'}] : []),
      {label:'Cancel Goal',value:'cancel'},
    ]);
    if (action === null || action === 'cancel') return null;
    if (action === 'finish') return criteria;
    if (action === 'add') {
      const value = await terminal.ask('New success criterion (required)');
      if (value) criteria.push(value);
    } else {
      const edit = await terminal.choose(`Criterion ${action+1}: ${criteria[action]}`, [{label:'Edit',value:'edit'},{label:'Delete',value:'delete'},{label:'Back',value:'back'}]);
      if (edit === 'delete') criteria.splice(action,1);
      if (edit === 'edit') { const value = await terminal.ask('Edit criterion',criteria[action]); if (value) criteria[action] = value; }
    }
  }
}
module.exports = { modelEntry, setupProfiles, editProfiles, collectCriteria };
