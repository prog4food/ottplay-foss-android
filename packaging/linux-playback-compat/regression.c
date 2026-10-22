/* Diagnostic reproduction of upstream 03febb5048's documented event sequence.
 * Uses public GStreamer APIs and a bounded thread wait, never application code. */
#include <gst/gst.h>
#include <stdio.h>
#include <string.h>
typedef struct {GstPad *pad; GMutex lock; GCond cond; gboolean started, done, result;} Work;
static gboolean consume(GstPad *pad, GstObject *parent, GstEvent *event) {
    (void)pad; (void)parent; gst_event_unref(event); return TRUE;
}
static gpointer segment(gpointer data) {
    Work *w=data; GstSegment s; gst_segment_init(&s,GST_FORMAT_TIME);
    s.start=121333000; s.time=s.start;
    g_mutex_lock(&w->lock); w->started=TRUE; g_cond_signal(&w->cond); g_mutex_unlock(&w->lock);
    gboolean ok=gst_pad_send_event(w->pad,gst_event_new_segment(&s));
    g_mutex_lock(&w->lock);w->result=ok;w->done=TRUE;g_cond_signal(&w->cond);g_mutex_unlock(&w->lock);
    return NULL;
}
static void start(GstPad *pad,const gchar *name) {
    GstEvent *e=gst_event_new_stream_start(name);gst_event_set_group_id(e,1);
    g_assert(gst_pad_send_event(pad,e));
}
int main(int argc,char **argv) {
    if(argc!=3)return 2;
    gboolean expect_blocked=!strcmp(argv[2],"unpatched");
    if(!expect_blocked && strcmp(argv[2],"patched"))return 2;
    gst_init(&argc,&argv);GError *err=NULL;
    GstPlugin *plugin=gst_plugin_load_file(argv[1],&err);
    if(!plugin){fprintf(stderr,"plugin load: %s\n",err?err->message:"unknown");return 3;}
    g_assert_cmpstr(gst_plugin_get_filename(plugin),==,argv[1]);
    GstElement *sync=gst_element_factory_make("streamsynchronizer",NULL);g_assert(sync);
    GstPad *v=gst_element_request_pad_simple(sync,"sink_%u");
    GstPad *a=gst_element_request_pad_simple(sync,"sink_%u");g_assert(v&&a);
    GstPad *outs[2],*sinks[2];
    for(int i=0;i<2;i++){
        gchar *name=g_strdup_printf("src_%d",i);outs[i]=gst_element_get_static_pad(sync,name);g_free(name);
        sinks[i]=gst_pad_new(NULL,GST_PAD_SINK);gst_pad_set_event_function(sinks[i],consume);
        g_assert(gst_pad_set_active(sinks[i],TRUE));g_assert(gst_pad_link(outs[i],sinks[i])==GST_PAD_LINK_OK);
    }
    g_assert(gst_element_set_state(sync,GST_STATE_PLAYING)!=GST_STATE_CHANGE_FAILURE);
    start(v,"video");
    g_assert(gst_pad_send_event(v,gst_event_new_flush_start()));
    g_assert(gst_pad_send_event(v,gst_event_new_flush_stop(TRUE)));
    start(a,"audio");
    Work w={0};w.pad=a;g_mutex_init(&w.lock);g_cond_init(&w.cond);
    GThread *thread=g_thread_new("audio-segment",segment,&w);
    gint64 deadline=g_get_monotonic_time()+3*G_TIME_SPAN_SECOND;
    g_mutex_lock(&w.lock);
    while(!w.started && g_cond_wait_until(&w.cond,&w.lock,deadline)){}
    g_assert(w.started);
    while(!w.done && g_cond_wait_until(&w.cond,&w.lock,deadline)){}
    gboolean blocked=!w.done;g_mutex_unlock(&w.lock);
    if(blocked)gst_pad_send_event(a,gst_event_new_flush_start());
    g_thread_join(thread);
    printf("{\"variant\":\"%s\",\"audio_segment_blocked\":%s,\"expected_blocked\":%s,\"audio_segment_accepted\":%s,\"released_for_cleanup\":%s}\n",argv[2],blocked?"true":"false",expect_blocked?"true":"false",w.result?"true":"false",blocked?"true":"false");
    gst_element_set_state(sync,GST_STATE_NULL);
    for(int i=0;i<2;i++){gst_pad_unlink(outs[i],sinks[i]);gst_object_unref(outs[i]);gst_pad_set_active(sinks[i],FALSE);gst_object_unref(sinks[i]);}
    gst_element_release_request_pad(sync,v);gst_element_release_request_pad(sync,a);
    gst_object_unref(v);gst_object_unref(a);gst_object_unref(sync);gst_object_unref(plugin);
    g_cond_clear(&w.cond);g_mutex_clear(&w.lock);gst_deinit();
    return blocked==expect_blocked && (expect_blocked || w.result)?0:1;
}
