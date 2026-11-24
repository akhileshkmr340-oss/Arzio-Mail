import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { api, type Task } from '../../lib/api';
import { useTheme } from '../../lib/theme';
import { Empty, ErrorLine, Loading } from '../../components/ui';

export default function Todo() {
  const t = useTheme();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { setTasks(await api.tasks()); setError(''); } catch (e) { setError((e as Error).message); } finally { setRefreshing(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const run = async (fn: () => Promise<unknown>) => { try { await fn(); await load(); } catch (e) { setError((e as Error).message); } };
  const add = () => { const v = title.trim(); if (!v) return; setTitle(''); run(() => api.addTask(v)); };

  if (!tasks) return error ? <ErrorLine text={error} /> : <Loading />;
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={[styles.add, { backgroundColor: t.panel, borderBottomColor: t.line }]}>
        <TextInput value={title} onChangeText={setTitle} onSubmitEditing={add} placeholder="Add a task" placeholderTextColor={t.muted} returnKeyType="done"
          style={[styles.input, { color: t.text, backgroundColor: t.bg }]} accessibilityLabel="New task" />
      </View>
      <ErrorLine text={error} />
      <FlatList
        data={tasks}
        keyExtractor={(x) => String(x.id)}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={t.brand} />}
        renderItem={({ item: x }) => {
          const done = !!x.completed_at;
          const overdue = !done && x.due_at && new Date(x.due_at) < new Date();
          return (
            <View style={[styles.row, { backgroundColor: t.panel, borderBottomColor: t.line }]}>
              <Pressable onPress={() => run(() => api.updateTask(x.id, { completed: !done }))} accessibilityRole="checkbox" accessibilityState={{ checked: done }} accessibilityLabel={x.title}
                style={[styles.check, { borderColor: done ? t.brand : t.muted, backgroundColor: done ? t.brand : 'transparent' }]}>
                {done ? <Text style={{ color: '#fff', fontWeight: '700' }}>✓</Text> : null}
              </Pressable>
              <View style={{ flex: 1 }}>
                <Text style={{ color: done ? t.muted : t.text, fontSize: 16, textDecorationLine: done ? 'line-through' : 'none' }}>{x.title}</Text>
                {x.due_at ? <Text style={{ color: overdue ? t.danger : t.muted, fontSize: 13 }}>Due {new Date(x.due_at).toLocaleDateString([], { day: 'numeric', month: 'short' })}</Text> : null}
              </View>
              <Pressable onPress={() => run(() => api.updateTask(x.id, { important: !x.important }))} accessibilityRole="button" accessibilityLabel={x.important ? 'Not important' : 'Mark important'} style={{ padding: 8 }}>
                <Text style={{ color: x.important ? t.brand : t.muted, fontSize: 20 }}>{x.important ? '★' : '☆'}</Text>
              </Pressable>
            </View>
          );
        }}
        ListEmptyComponent={<Empty title="No tasks">Add one above, or flag an email.</Empty>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  add: { padding: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  input: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, marginRight: 12, alignItems: 'center', justifyContent: 'center' },
});
