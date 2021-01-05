// Import of the default condition.

let reasons = [];  // pieces of the status description
let shortReasons = [];  // pieces of the short status desc.
const summary = review.summary;  // shortcut to summary
const designatedReviewers =
  _.isEmpty(review.pullRequest.requestedReviewers) ?
    review.pullRequest.assignees :
    review.pullRequest.requestedReviewers;

const completed =
  !summary.numUnresolvedDiscussions &&
  !summary.numUnreviewedFiles;

if (summary.numUnreviewedFiles) {
  reasons.push(
    (summary.numFiles - summary.numUnreviewedFiles) +
    ' of ' + summary.numFiles + ' files reviewed');
  shortReasons.push(
    summary.numUnreviewedFiles + ' file' +
    (summary.numUnreviewedFiles > 1 ? 's' : '')
  );
} else {
  reasons.push('all files reviewed');
}

if (summary.numUnresolvedDiscussions) {
  reasons.push(
    summary.numUnresolvedDiscussions +
    ' unresolved discussion' +
    (summary.numUnresolvedDiscussions > 1 ? 's' : ''));
  shortReasons.push(
    summary.numUnresolvedDiscussions + ' discussion' +
    (summary.numUnresolvedDiscussions > 1 ? 's' : '')
  );
} else {
  reasons.push('all discussions resolved');
}

const discussionBlockers = _(review.discussions)
  .filter({resolved: false})
  .map('participants')
  .flatten()
  .filter({resolved: false})
  .map(user => _.pick(user, 'username'))
  .value();

const lastReviewedRevisionsOfUnreviewedFiles = _(review.files)
  .filter(file => {
    let rev = _(file.revisions).reject('obsolete').last();
    if (!rev) rev = _.last(file.revisions);
    return _.isEmpty(rev.reviewers);
  }).map(file => _.findLast(
    file.revisions, rev => !_.isEmpty(rev.reviewers)))
  .value();

const fileBlockers = _(lastReviewedRevisionsOfUnreviewedFiles)
  .compact()
  .map('reviewers')
  .flatten()
  .value();

const missingReviewers =
  _.some(lastReviewedRevisionsOfUnreviewedFiles, rev => !rev) ?
    designatedReviewers :
    _.filter(designatedReviewers, {participating: false});

const pendingReviewers = _(fileBlockers)
  .concat(discussionBlockers)
  .concat(missingReviewers)
  .map(user => _.pick(user, 'username'))
  .uniq('username')
  .value();

const mergeability = review.pullRequest.mergeability;
if (_.isEmpty(pendingReviewers)) {
  const readyToMerge = review.pullRequest.target.branchProtected ?
    _.includes(['has_hooks', 'clean', 'unstable'], mergeability) :
    completed && mergeability !== 'draft' && _.every(
      info.pullRequest.checks, check => !check.required || check.success);
  if (readyToMerge) pendingReviewers.push(info.pullRequest.author);
}

let shortDescription;
if (completed) {
  shortDescription =
    summary.numFiles + ' file' +
    (summary.numFiles > 1 ? 's' : '') + ' reviewed';
} else {
  shortDescription = shortReasons.join(', ') + ' left';
}

return {
  completed,
  description: reasons.join(', '),
  shortDescription,
  pendingReviewers
};


// The number of LGTMs required to merge.
let numApprovalsRequired = 1;

// Approval by username: true if current LGTM, false if stale,
// missing if not given or canceled.
const approvals = {};

// Timestamp of the currently latest revision.
const lastRevisionTimestamp =
  _(review.revisions).reject('obsolete').last().snapshotTimestamp;

_.forEach(review.sentiments, function(sentiment) {
  const emojis = _.keyBy(sentiment.emojis);
  if (emojis.lgtm_cancel) {
    delete approvals[sentiment.username];
  } else if (emojis.lgtm_strong) {
    approvals[sentiment.username] = true;
  } else if (emojis.lgtm && !approvals[sentiment.username]) {
    approvals[sentiment.username] =
      sentiment.timestamp >= lastRevisionTimestamp;
  }
});

const numApprovals = _.countBy(approvals);
let numGranted = numApprovals.true || 0;
let pendingReviewers = [];

const designatedReviewers =
  _.isEmpty(review.pullRequest.requestedReviewers) ?
    review.pullRequest.assignees :
    review.pullRequest.requestedReviewers;
const required = _.map(designatedReviewers, 'username');
if (required.length) {
  numApprovalsRequired =
    _.max([required.length, numApprovalsRequired]);
  numGranted =
    (_(approvals).pick(required).countBy().value().true || 0) +
    _.min([numGranted, numApprovalsRequired - required.length]);
  pendingReviewers = _(required)
    .reject(username => approvals[username])
    .map(username => ({username}))
    .value();
}

let description =
  numGranted + ' of ' + numApprovalsRequired + ' LGTMs obtained';
let shortDescription =
  numGranted + '/' + numApprovalsRequired + ' LGTMs';
if (numApprovals.false) {
  description += ', and ' + numApprovals.false + ' stale';
  shortDescription += ', ' + numApprovals.false + ' stale';
}

return {
  completed: numGranted >= numApprovalsRequired,
  description, shortDescription, pendingReviewers,
  debug: approvals
};
