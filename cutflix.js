(function () {
    'use strict';

    if (window.plugin_cutflix_ready) return;
    window.plugin_cutflix_ready = true;

    var DEFAULT_URL = 'https://www.cutflix.ru';
    var PAGE_SIZE = 24;
    var CACHE_TTL = 1000 * 60 * 5;
    var HLS_TYPE = 'hlsjs';
    var cache = {};
    var added = false;
    var forced_player = null;
    var restore_timer = null;
    var playback_network = null;
    var playlist_patch_installed = false;

    var ICON = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 5.5C4 4.67157 4.67157 4 5.5 4H18.5C19.3284 4 20 4.67157 20 5.5V18.5C20 19.3284 19.3284 20 18.5 20H5.5C4.67157 20 4 19.3284 4 18.5V5.5Z" stroke="currentColor" stroke-width="1.7"/><path d="M8 4V20M16 4V20M4 9H8M4 15H8M16 9H20M16 15H20" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

    var PLAY_ICON = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 5.5L18 12L8 18.5V5.5Z" fill="currentColor"/></svg>';

    function baseUrl() {
        var value = Lampa.Storage.get('cutflix_url', DEFAULT_URL);
        value = String(value || DEFAULT_URL).trim();
        if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
        return value.replace(/\/+$/, '');
    }

    function apiUrl(path) {
        return baseUrl() + '/api/' + String(path).replace(/^\/+/, '');
    }

    function imageUrl(uuid, width, height) {
        if (!uuid) return '';
        return apiUrl('image/' + uuid + '?w=' + width + '&h=' + height + '&fm=webp');
    }

    function streamUrl(videoId) {
        return apiUrl('video/' + videoId + '.m3u8');
    }

    function fileUrl(fileUuid) {
        if (!fileUuid) return '';
        return apiUrl('file/' + fileUuid);
    }

    function absoluteUrl(base, uri) {
        try {
            return new URL(uri, base).href;
        } catch (e) {
            if (/^(https?:)?\/\//i.test(uri) || uri.indexOf('data:') === 0) return uri;

            var clean = String(base).split('?')[0].split('#')[0];

            return clean.substring(0, clean.lastIndexOf('/') + 1) + uri;
        }
    }

    function isCutflixPlaylist(url) {
        var host = '';

        try {
            host = new URL(url).host.toLowerCase();
        } catch (e) {
            return /cutflix\.ru/i.test(url);
        }

        var base = '';

        try {
            base = new URL(baseUrl()).host.toLowerCase();
        } catch (e) {}

        return host === base || /(^|\.)cutflix\.ru$/i.test(host);
    }

    function rewriteInitSegments(text, playlistUrl) {
        text = String(text);

        if (!isCutflixPlaylist(playlistUrl)) return text;
        if (text.indexOf('#EXT-X-MAP') === -1) return text;
        if (/#EXT-X-STREAM-INF:/.test(text)) return text;

        var lines = text.replace(/\r/g, '').split('\n');
        var pending = -1;
        var changed = false;

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();

            if (!line) continue;

            if (line.indexOf('#EXT-X-MAP:') === 0) {
                if (line.indexOf('URI="') !== -1 && line.indexOf('BYTERANGE="') !== -1) pending = i;

                continue;
            }

            if (line.charAt(0) === '#') continue;

            if (pending === -1) continue;

            var media = absoluteUrl(playlistUrl, line);

            if (!/\.m3u8(?:[?#]|$)/i.test(media)) {
                lines[pending] = lines[pending].replace(/URI="[^"]*"/, 'URI="' + media + '"');
                changed = true;
            }

            pending = -1;
        }

        return changed ? lines.join('\n') : text;
    }

    function installPlaylistPatch() {
        if (playlist_patch_installed) return;
        if (typeof Hls === 'undefined' || !Hls.DefaultConfig) return;

        var Default = Hls.DefaultConfig;
        var Original = Default.pLoader || Default.loader;

        if (!Original) return;

        function CutflixPlaylistLoader(config) {
            this.loader = new Original(config);
            this.stats = this.loader.stats;
            this.context = null;
        }

        CutflixPlaylistLoader.prototype.load = function (context, config, callbacks) {
            this.context = context;

            this.loader.load(context, config, {
                onSuccess: function (response, stats, ctx, network) {
                    try {
                        if (response && typeof response.data === 'string' && response.data.indexOf('#EXT-X-MAP') !== -1) {
                            var url = (ctx && ctx.url) || (context && context.url) || '';
                            var rewritten = rewriteInitSegments(response.data, url);

                            if (rewritten !== response.data) {
                                response.data = rewritten;

                                console.log('Cutflix', 'init segment redirected to media host');
                            }
                        }
                    } catch (e) {}

                    if (callbacks.onSuccess) callbacks.onSuccess(response, stats, ctx, network);
                },
                onError: function (response, stats, ctx, network) {
                    if (callbacks.onError) callbacks.onError(response, stats, ctx, network);
                },
                onTimeout: function (stats, ctx, network) {
                    if (callbacks.onTimeout) callbacks.onTimeout(stats, ctx, network);
                },
                onAbort: function (stats, ctx, network) {
                    if (callbacks.onAbort) callbacks.onAbort(stats, ctx, network);
                },
                onProgress: function (stats, ctx, data, network) {
                    if (callbacks.onProgress) callbacks.onProgress(stats, ctx, data, network);
                }
            });
        };

        CutflixPlaylistLoader.prototype.abort = function () {
            if (this.loader) this.loader.abort();
        };

        CutflixPlaylistLoader.prototype.destroy = function () {
            if (this.loader) this.loader.destroy();
        };

        Default.pLoader = CutflixPlaylistLoader;
        playlist_patch_installed = true;

        console.log('Cutflix', 'hls playlist patch installed');
    }

    function playbackNetwork() {
        if (!playback_network) {
            playback_network = new Lampa.Reguest();
            playback_network.timeout(20000);
        }

        return playback_network;
    }

    function warmPlaylistUrl(url) {
        if (!url || url.indexOf('http') !== 0) return;

        playbackNetwork().silent(url, function () {}, function () {}, false, {
            headers: {
                'Accept': '*/*'
            },
            dataType: 'text',
            timeout: 20000
        });
    }

    function preheatPlaylist(videoId, text) {
        var base = streamUrl(videoId);
        var target = Number(Lampa.Storage.field('video_quality_default')) || 0;
        var variants = [];
        var audioUri = '';
        var waiting = null;

        String(text).replace(/\r/g, '').split('\n').forEach(function (line) {
            line = line.trim();

            if (!line) return;

            if (line.charAt(0) === '#') {
                if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
                    var match = line.match(/RESOLUTION=(\d+)x(\d+)/);

                    waiting = {
                        height: match ? parseInt(match[2], 10) : 0,
                        uri: ''
                    };

                    variants.push(waiting);
                } else if (line.indexOf('#EXT-X-MEDIA:') === 0
                    && line.indexOf('TYPE=AUDIO') !== -1
                    && line.indexOf('DEFAULT=YES') !== -1) {
                    var audio = line.match(/URI="([^"]*)"/);

                    audioUri = audio ? absoluteUrl(base, audio[1]) : '';
                }

                return;
            }

            if (waiting) {
                waiting.uri = absoluteUrl(base, line);

                waiting = null;
            }
        });

        warmPlaylistUrl(audioUri);

        var best = null;

        variants.forEach(function (variant) {
            if (!variant.uri) return;

            if (!best) {
                best = variant;
                return;
            }

            if (!target) {
                if (variant.height > best.height) best = variant;
            } else if (Math.abs(variant.height - target) < Math.abs(best.height - target)) {
                best = variant;
            }
        });

        if (best) warmPlaylistUrl(best.uri);
    }

    function loadMasterManifest(videoId, success, error) {
        if (!videoId) {
            error();
            return;
        }

        var key = 'manifest:' + videoId;
        var text = cacheGet(key);

        if (typeof text === 'string') {
            success(text);
            return;
        }

        playbackNetwork().silent(streamUrl(videoId), function (data) {
            if (typeof data !== 'string' || data.indexOf('#EXTM3U') === -1) {
                error();
                return;
            }

            cacheSet(key, data);

            success(data);
        }, function () {
            error();
        }, false, {
            headers: {
                'Accept': '*/*'
            },
            dataType: 'text',
            timeout: 20000
        });
    }

    function playEntry(url, title, timeline) {
        return {
            url: url,
            title: title || '',
            timeline: timeline
        };
    }

    function hlsSupported() {
        try {
            return typeof Hls !== 'undefined' && Hls.isSupported && Hls.isSupported();
        } catch (e) {
            return false;
        }
    }

    function canUseProgramHls() {
        if (!hlsSupported()) return false;

        var platform = Lampa.Platform;
        var player = Lampa.Storage.field('player');

        if (platform.is('android') && player == 'android') return false;
        if (platform.is('orsay') && player == 'orsay') return false;
        if (platform.is('webos') && player == 'webos') return false;
        if (platform.is('apple_tv')) return false;
        if (platform.desktop() && player == 'other') return false;
        if (platform.macOS() && player != 'inner') return false;
        if (platform.is('apple') && player != 'inner' && player != 'ios') return false;

        return true;
    }

    function needsInnerPlayer() {
        return Lampa.Platform.is('tizen') && Lampa.Storage.field('player') == 'tizen';
    }

    function setPlayer(player) {
        var current = Lampa.Storage.field('player');

        if (current == player) return;

        if (forced_player === null) {
            forced_player = current;

            if (Lampa.Player && Lampa.Player.listener)
                Lampa.Player.listener.follow('destroy', syncRestorePlayer);
        }

        Lampa.Storage.set('player', player);
    }

    function useInnerPlayer() {
        if (Lampa.Storage.field('player') == 'inner') return;

        setPlayer('inner');
    }

    function useNativePlayer() {
        if (Lampa.Storage.field('player') == 'tizen') return;

        setPlayer('tizen');
    }

    function syncRestorePlayer() {
        if (forced_player === null || restore_timer) return;

        restore_timer = setTimeout(restorePlayer, 1);
    }

    function restorePlayer() {
        clearTimeout(restore_timer);
        restore_timer = null;

        if (forced_player === null) return;

        Lampa.Storage.set('player', forced_player);
        forced_player = null;
    }

    function preparePlayback(entry, done) {
        var original = entry.master_url || entry.url;
        var native_file = Lampa.Platform.is('tizen') ? fileUrl(entry.file_uuid) : '';

        function finish(url) {
            entry.url = url;

            done(entry);
        }

        if (native_file && !hlsSupported()) {
            console.log('Cutflix', 'native file fallback', Lampa.Platform.get());

            delete entry.hls_type;
            delete entry.error;

            useNativePlayer();
            finish(native_file);
            return;
        }

        if (!canUseProgramHls()) {
            console.log('Cutflix', 'quality off', Lampa.Platform.get(), Lampa.Storage.field('player'));

            delete entry.hls_type;
            delete entry.error;

            finish(original);
            return;
        }

        installPlaylistPatch();

        entry.hls_type = HLS_TYPE;

        console.log('Cutflix', 'quality on', Lampa.Platform.get(), Lampa.Storage.field('player'), needsInnerPlayer() ? 'inner' : '');

        entry.hls_manifest_timeout = 25000;
        entry.hls_retry_timeout = 45000;

        if (needsInnerPlayer()) useInnerPlayer();

        if (native_file) {
            entry.error = function (data, reserve) {
                console.log('Cutflix', 'hls failed, switching to native file');

                useNativePlayer();
                reserve(native_file);
            };
        } else delete entry.error;

        loadMasterManifest(entry.video_id, function (text) {
            preheatPlaylist(entry.video_id, text);

            console.log('Cutflix', 'master playlist preloaded');

            finish(original);
        }, function () {
            console.log('Cutflix', 'master preload failed, using direct url');

            finish(original);
        });
    }

    function lazyEntry(videoId, title, timeline, fileUuid) {
        var entry = playEntry(streamUrl(videoId), title, timeline);
        var master = entry.url;

        entry.video_id = videoId;
        entry.file_uuid = fileUuid || '';
        entry.master_url = master;
        entry.url = function (done) {
            preparePlayback(entry, done || function () {});
        };

        return entry;
    }

    function prepareEntry(entry, done) {
        if (entry && typeof entry.url === 'function') entry.url(function () {
            done(entry);
        });
        else done(entry);
    }

    function t(key) {
        return Lampa.Lang.translate(key);
    }

    function posterUuid(item) {
        if (item && item.poster && item.poster.uuid) return item.poster.uuid;
        if (item && item.video && item.video.image && item.video.image.uuid) return item.video.image.uuid;
        return '';
    }

    function isCategory(item) {
        return item && (item.type === 'category' || (!item.video_id && item.publications_count));
    }

    function yearOf(item) {
        if (!item || !item.published_at) return '';
        return String(item.published_at).slice(0, 4);
    }

    function mapPublication(item) {
        var poster = imageUrl(posterUuid(item), 300, 450);
        return {
            id: item.id,
            alias: item.alias,
            title: item.title || '',
            img: poster,
            poster: poster,
            release_year: yearOf(item),
            type: isCategory(item) ? 'category' : 'publication',
            category_id: item.category_id,
            video_id: item.video_id,
            file_uuid: item.video && item.video.file ? item.video.file.uuid : '',
            views_count: item.views_count,
            publications_count: item.publications_count || 0,
            description: item.description || ''
        };
    }

    function mapList(json) {
        var rows = (json && json.rows) || [];
        var total = Number(json && json.total);
        if (!isFinite(total)) total = rows.length;
        return {
            results: rows.map(mapPublication),
            total_pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
            card_category: false
        };
    }

    function cacheGet(key) {
        var entry = cache[key];
        if (entry && (Date.now() - entry.time) < CACHE_TTL) return entry.value;
        if (entry) delete cache[key];
        return null;
    }

    function cacheSet(key, value) {
        cache[key] = {
            time: Date.now(),
            value: value
        };
    }

    function createNetwork() {
        var network = new Lampa.Reguest();
        network.timeout(15000);
        return network;
    }

    function fetchJson(path, network, success, error) {
        var key = baseUrl() + '|' + path;
        var cached = cacheGet(key);

        if (cached) {
            success(cached);
            return;
        }

        network.silent(apiUrl(path), function (data) {
            cacheSet(key, data);
            success(data);
        }, function () {
            if (error) error();
        }, false, {
            headers: {
                'Accept': 'application/json'
            }
        });
    }

    function formatViews(value) {
        var count = Number(value) || 0;
        if (count >= 1000000) return (count / 1000000).toFixed(1).replace('.0', '') + 'M';
        if (count >= 1000) return (count / 1000).toFixed(1).replace('.0', '') + 'K';
        return String(count);
    }

    function formatDuration(seconds) {
        var total = Math.max(0, Math.round(Number(seconds) || 0));
        var hours = Math.floor(total / 3600);
        var minutes = Math.floor((total % 3600) / 60);
        if (hours) return hours + ' ' + t('cutflix_hour') + ' ' + minutes + ' ' + t('cutflix_min');
        return minutes + ' ' + t('cutflix_min');
    }

    function timelineFor(alias) {
        if (!Lampa.Timeline || !Lampa.Timeline.view) return undefined;
        return Lampa.Timeline.view(Lampa.Utils.hash('cutflix_' + alias));
    }

    function addTranslations() {
        Lampa.Lang.add({
            cutflix_title: {
                ru: 'Cutflix',
                uk: 'Cutflix',
                en: 'Cutflix'
            },
            cutflix_watch: {
                ru: 'Смотреть',
                uk: 'Дивитися',
                en: 'Watch'
            },
            cutflix_loading: {
                ru: 'Загрузка Cutflix',
                uk: 'Завантаження Cutflix',
                en: 'Loading Cutflix'
            },
            cutflix_error: {
                ru: 'Не удалось загрузить данные Cutflix',
                uk: 'Не вдалося завантажити дані Cutflix',
                en: 'Failed to load Cutflix data'
            },
            cutflix_retry: {
                ru: 'Повторить',
                uk: 'Повторити',
                en: 'Retry'
            },
            cutflix_no_video: {
                ru: 'Видео недоступно',
                uk: 'Відео недоступне',
                en: 'Video is not available'
            },
            cutflix_views: {
                ru: 'просмотров',
                uk: 'переглядів',
                en: 'views'
            },
            cutflix_hour: {
                ru: 'ч',
                uk: 'год',
                en: 'h'
            },
            cutflix_min: {
                ru: 'мин',
                uk: 'хв',
                en: 'min'
            },
            cutflix_settings_url: {
                ru: 'Адрес Cutflix',
                uk: 'Адреса Cutflix',
                en: 'Cutflix URL'
            },
            cutflix_settings_url_descr: {
                ru: 'Основной адрес или зеркало сайта',
                uk: 'Основна адреса або дзеркало сайту',
                en: 'Main site URL or mirror'
            }
        });
    }

    function injectStyle() {
        if (document.getElementById('cutflix-style')) return;

        var css = [
            '.cutflix-item{position:relative;min-height:100%;box-sizing:border-box;padding:4em 5em;overflow:hidden}',
            '.cutflix-item__bg{position:absolute;left:-4em;top:-4em;right:-4em;bottom:-4em;background-size:cover;background-position:center;opacity:.16;filter:blur(28px);transform:scale(1.08);pointer-events:none}',
            '.cutflix-item__inner{position:relative;display:flex;align-items:flex-start;gap:3em;max-width:110em;margin:0 auto}',
            '.cutflix-item__poster{flex:0 0 22em;width:22em;aspect-ratio:2/3;border-radius:.5em;overflow:hidden;background:rgba(255,255,255,.06)}',
            '.cutflix-item__poster img{display:block;width:100%;height:100%;object-fit:cover}',
            '.cutflix-item__body{flex:1;min-width:0;padding-top:.5em}',
            '.cutflix-item__title{font-size:2.4em;font-weight:600;line-height:1.2;margin-bottom:.5em}',
            '.cutflix-item__meta{font-size:1.2em;opacity:.6;margin-bottom:1.6em}',
            '.cutflix-item__descr{font-size:1.3em;line-height:1.55;opacity:.9;white-space:pre-line;max-width:60em;margin-bottom:2em}',
            '.cutflix-item__play{display:inline-flex;align-items:center;gap:.6em;font-size:1.3em;padding:.8em 2em}',
            '.cutflix-item__play svg{width:1.4em;height:1.4em}',
            '.cutflix-item__error{position:relative;max-width:50em;margin:4em auto;text-align:center}',
            '.cutflix-item__error-text{font-size:1.6em;margin-bottom:1.5em;opacity:.8}',
            '.cutflix-item__retry{display:inline-flex;align-items:center;justify-content:center;font-size:1.3em;padding:.8em 2em}',
            '@media (max-width:800px){.cutflix-item{padding:2em}.cutflix-item__inner{flex-direction:column;gap:2em}.cutflix-item__poster{flex:0 0 14em;width:14em}.cutflix-item__title{font-size:2em}}'
        ].join('');

        $('<style id="cutflix-style"></style>').text(css).appendTo('head');
    }

    function CatalogComponent(object) {
        var component = new Lampa.InteractionCategory(object);
        var network = createNetwork();

        function categoryId() {
            return object.category_id || (object.component === 'cutflix_category' ? object.id : null);
        }

        function pathFor(page) {
            var path = 'web/publications?limit=' + PAGE_SIZE + '&page=' + page;
            var id = categoryId();
            if (id) path += '&category_id=' + encodeURIComponent(id);
            return path;
        }

        function load(page, resolve, reject) {
            fetchJson(pathFor(page), network, function (json) {
                var data = mapList(json);

                if (categoryId()) {
                    data.results.sort(function (a, b) {
                        return String(a.title || '').localeCompare(String(b.title || ''), 'ru', {
                            numeric: true
                        });
                    });
                }

                resolve(data);
            }, function () {
                reject();
            });
        }

        component.create = function () {
            var self = this;
            this.activity.loader(true);
            load(1, function (data) {
                self.activity.loader(false);
                self.build(data);
            }, function () {
                self.activity.loader(false);
                Lampa.Noty.show(t('cutflix_error'));
                self.empty();
            });
        };

        component.nextPageReuest = function (obj, resolve, reject) {
            load(obj.page, resolve, reject);
        };

        component.cardRender = function (obj, element, card) {
            card.onMenu = false;
            card.onEnter = function () {
                if (element.type === 'category') {
                    Lampa.Activity.push({
                        url: '',
                        title: element.title,
                        component: 'cutflix_category',
                        id: element.id,
                        category_id: element.id,
                        alias: element.alias,
                        page: 1
                    });
                } else {
                    Lampa.Activity.push({
                        url: '',
                        title: element.title,
                        component: 'cutflix_item',
                        alias: element.alias,
                        category_id: element.category_id || categoryId(),
                        page: 1
                    });
                }
            };
        };

        var base_destroy = component.destroy;

        component.destroy = function () {
            network.clear();

            if (base_destroy) base_destroy.call(component);
        };

        return component;
    }

    function ItemComponent(object) {
        var network = createNetwork();
        var html = $('<div class="cutflix-item"></div>');
        var bg = $('<div class="cutflix-item__bg"></div>').appendTo(html);
        var content = $('<div class="cutflix-item__inner"></div>').appendTo(html);
        var data = null;
        var playButton = null;
        var started = false;
        var destroyed = false;
        var playing = false;

        function back() {
            Lampa.Activity.backward();
        }

        function focusPlay() {
            Lampa.Controller.collectionSet(html);
            if (playButton && playButton.length) Lampa.Controller.collectionFocus(playButton[0], html);
            else Lampa.Controller.collectionFocus(false, html);
        }

        function buildPlaylist(callback) {
            if (!object.category_id) {
                callback(null);
                return;
            }

            var path = 'web/publications?category_id=' + encodeURIComponent(object.category_id) + '&limit=100&page=1';

            fetchJson(path, network, function (json) {
                var rows = ((json && json.rows) || []).filter(function (row) {
                    return row.video_id;
                });

                rows.sort(function (a, b) {
                    return String(a.title || '').localeCompare(String(b.title || ''), 'ru', {
                        numeric: true
                    });
                });

                callback(rows.map(function (row) {
                    var entry = lazyEntry(row.video_id, row.title, timelineFor(row.alias), row.video && row.video.file ? row.video.file.uuid : '');
                    entry.thumbnail = imageUrl(posterUuid(row), 200, 300);
                    return entry;
                }));
            }, function () {
                callback(null);
            });
        }

        function play() {
            if (playing) return;
            if (!data || !data.video || !data.video.id) {
                Lampa.Noty.show(t('cutflix_no_video'));
                return;
            }

            playing = true;
            Lampa.Loading.start(function () {
                Lampa.Loading.stop();
                playing = false;
            }, t('cutflix_loading'));

            buildPlaylist(function (playlist) {
                var list = playlist || [];
                var current = null;

                list.forEach(function (entry) {
                    if (entry.video_id === data.video.id) current = entry;
                });

                if (!current) {
                    current = lazyEntry(data.video.id, data.title, timelineFor(data.alias), data.video.file ? data.video.file.uuid : '');
                    list.push(current);
                }

                prepareEntry(current, function () {
                    Lampa.Loading.stop();
                    playing = false;

                    if (destroyed) return;

                    current.playlist = list.length > 1 ? list : undefined;

                    try {
                        Lampa.Player.play(current);
                    } catch (e) {
                        restorePlayer();
                    }
                });
            });
        }

        function renderContent() {
            content.empty();
            playButton = null;

            var poster = imageUrl(posterUuid(data), 400, 600);
            var meta = [];

            if (yearOf(data)) meta.push(yearOf(data));
            if (data.video && data.video.duration) meta.push(formatDuration(data.video.duration));
            if (data.views_count != null) meta.push(formatViews(data.views_count) + ' ' + t('cutflix_views'));

            var posterBox = $('<div class="cutflix-item__poster"></div>');
            if (poster) $('<img alt="" />').attr('src', poster).appendTo(posterBox);

            var body = $('<div class="cutflix-item__body"></div>');
            var button = $('<div class="simple-button selector cutflix-item__play"></div>');

            button.append(PLAY_ICON);
            button.append($('<span></span>').text(t('cutflix_watch')));
            button.on('hover:enter click', play);

            playButton = button;

            body.append($('<div class="cutflix-item__title"></div>').text(data.title || ''));
            body.append($('<div class="cutflix-item__meta"></div>').text(meta.join(' · ')));
            body.append($('<div class="cutflix-item__descr"></div>').text(data.description || ''));
            body.append($('<div class="cutflix-item__actions"></div>').append(button));

            content.append(posterBox, body);
            if (poster) bg.css('background-image', 'url("' + poster + '")');
        }

        function renderError(self) {
            content.empty();
            playButton = null;

            var box = $('<div class="cutflix-item__error"></div>');
            var retry = $('<div class="simple-button selector cutflix-item__retry"></div>');

            retry.text(t('cutflix_retry'));
            retry.on('hover:enter click', function () {
                load(self);
            });

            box.append($('<div class="cutflix-item__error-text"></div>').text(t('cutflix_error')));
            box.append(retry);
            content.append(box);
            playButton = retry;
        }

        function load(self) {
            content.empty();
            data = null;
            playButton = null;

            if (self.activity) self.activity.loader(true);

            fetchJson('web/publications/' + encodeURIComponent(object.alias), network, function (row) {
                if (destroyed) return;

                data = row;
                renderContent();

                var poster = imageUrl(posterUuid(row), 400, 600);
                if (poster) Lampa.Background.change(poster);

                if (self.activity) self.activity.loader(false);
                if (started) self.start();
            }, function () {
                if (destroyed) return;

                renderError(self);
                if (self.activity) self.activity.loader(false);
                if (started) self.start();
            });
        }

        this.create = function () {
            load(this);
            return this.render();
        };

        this.start = function () {
            started = true;

            Lampa.Controller.add('content', {
                toggle: focusPlay,
                left: function () {
                    Lampa.Controller.toggle('menu');
                },
                up: function () {
                    Lampa.Controller.toggle('head');
                },
                back: back
            });

            Lampa.Controller.toggle('content');
        };

        this.pause = function () {};

        this.stop = function () {};

        this.destroy = function () {
            destroyed = true;

            restorePlayer();

            network.clear();
            html.remove();
        };

        this.render = function (js) {
            return js ? html[0] : html;
        };

        this.back = back;
    }

    function addMenu() {
        var action = function () {
            Lampa.Activity.push({
                url: '',
                title: t('cutflix_title'),
                component: 'cutflix_catalog',
                page: 1
            });
        };

        if (Lampa.Menu && Lampa.Menu.addButton) {
            Lampa.Menu.addButton(ICON, t('cutflix_title'), action);
            return;
        }

        if ($('.menu .menu__list [data-action="cutflix"]').length) return;

        var item = $('<li class="menu__item selector" data-action="cutflix"><div class="menu__ico"></div><div class="menu__text"></div></li>');

        item.find('.menu__ico').html(ICON);
        item.find('.menu__text').text(t('cutflix_title'));
        item.on('hover:enter click', action);

        $('.menu .menu__list').eq(0).append(item);
    }

    function addSettings() {
        if (Lampa.SettingsApi.getComponent('cutflix')) return;

        Lampa.SettingsApi.addComponent({
            component: 'cutflix',
            icon: ICON,
            name: t('cutflix_title')
        });

        Lampa.SettingsApi.addParam({
            component: 'cutflix',
            param: {
                name: 'cutflix_url',
                type: 'input',
                default: DEFAULT_URL,
                placeholder: DEFAULT_URL
            },
            field: {
                name: t('cutflix_settings_url'),
                description: t('cutflix_settings_url_descr')
            }
        });
    }

    function add() {
        if (added) return;
        added = true;

        addTranslations();
        injectStyle();

        Lampa.Component.add('cutflix_catalog', CatalogComponent);
        Lampa.Component.add('cutflix_category', CatalogComponent);
        Lampa.Component.add('cutflix_item', ItemComponent);

        addMenu();
        addSettings();
    }

    if (window.appready) add();
    else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') add();
        });
    }
})();
