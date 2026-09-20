import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/exceptions.dart';
import '../api/models.dart';
import 'create_project_screen.dart';

/// TASK-307 (P-7a) — lists the tenant's projects (`GET /projects`) with
/// real loading / empty / error states, and starts the create-project flow.
///
/// [detailBuilder] lets the project-detail screen (TASK-308) be wired in
/// without this file knowing about it; when null a tile is inert.
class ProjectsScreen extends StatefulWidget {
  const ProjectsScreen({
    super.key,
    required this.apiClient,
    this.detailBuilder,
  });

  final ApiClient apiClient;
  final Widget Function(BuildContext context, Project project)? detailBuilder;

  @override
  State<ProjectsScreen> createState() => _ProjectsScreenState();
}

class _ProjectsScreenState extends State<ProjectsScreen> {
  List<Project> _projects = const [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final projects = await widget.apiClient.listProjects();
      if (!mounted) return;
      setState(() => _projects = projects);
    } on UnauthorizedError {
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not load projects.');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _openCreate() async {
    final created = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => CreateProjectScreen(apiClient: widget.apiClient),
      ),
    );
    if (created == true) await _load();
  }

  void _open(Project project) {
    final builder = widget.detailBuilder;
    if (builder == null) return;
    Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (context) => builder(context, project)),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Projects'),
        actions: [
          IconButton(
            key: const Key('new-project-button'),
            icon: const Icon(Icons.add),
            tooltip: 'New project',
            onPressed: _openCreate,
          ),
        ],
      ),
      body: RefreshIndicator(onRefresh: _load, child: _buildBody()),
    );
  }

  Widget _buildBody() {
    if (_loading && _projects.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return ListView(
        children: [
          const SizedBox(height: 80),
          Center(child: Text(_error!, key: const Key('projects-error'))),
          const SizedBox(height: 12),
          Center(
            child: FilledButton(
              key: const Key('projects-retry'),
              onPressed: _load,
              child: const Text('Try again'),
            ),
          ),
        ],
      );
    }
    if (_projects.isEmpty) {
      return ListView(
        children: const [
          SizedBox(height: 80),
          Center(
            key: Key('projects-empty'),
            child: Text('No projects yet — create one to get bots working together.'),
          ),
        ],
      );
    }
    return ListView.builder(
      key: const Key('projects-list'),
      itemCount: _projects.length,
      itemBuilder: (context, index) {
        final project = _projects[index];
        return ListTile(
          key: Key('project-tile-${project.projectId}'),
          title: Text(project.name),
          subtitle: Text(
            project.goal,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
          trailing: Text(project.status),
          onTap: () => _open(project),
        );
      },
    );
  }
}
